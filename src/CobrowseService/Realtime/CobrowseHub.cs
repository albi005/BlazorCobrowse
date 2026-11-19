using System.Text.Json;
using CobrowseService.Auth;
using CobrowseService.Contracts;
using CobrowseService.Sessions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace CobrowseService.Realtime;

public sealed class CobrowseHub(
    SupportRequestService requests,
    SessionRegistry sessions,
    JoinTicketService tickets,
    ISupportEvents events,
    IAgentIdentityProvider agents,
    IOptions<CobrowseOptions> options,
    ILogger<CobrowseHub> logger) : Hub
{
    private const int BacklogChunkSize = 300;

    private static readonly HashSet<string> AllowedActions =
        new(StringComparer.Ordinal) { "click", "setValue", "scroll", "scrollTo", "highlight", "key", "paste" };

    private CobrowseOptions Options => options.Value;

    // -------------------------------------------------------------- customer

    /// <summary>
    /// Attach the customer's page to its request. The join token is the only
    /// credential: it is minted server-side by the tenant plugin, scoped to one
    /// request, and revoked when the request ends.
    /// </summary>
    public async Task JoinAsCustomer(JoinCustomerRequest request)
    {
        var grant = tickets.Resolve(request.Token, TicketKind.Customer)
                    ?? throw new HubException("invalid-ticket");

        var snapshot = requests.Get(grant.RequestId)
                       ?? throw new HubException("request-not-found");

        if (snapshot.IsTerminal)
            throw new HubException("request-closed");

        if (request.Protocol < Options.MinHubProtocol || request.Protocol > Options.MaxHubProtocol)
        {
            logger.LogWarning(
                "Rejecting customer {RequestId} on hub protocol {Protocol} (supported {Min}-{Max}).",
                snapshot.Id, request.Protocol, Options.MinHubProtocol, Options.MaxHubProtocol);
            throw new HubException("protocol-unsupported");
        }

        var room = sessions.GetOrCreate(snapshot.Id);

        string? previousCustomer;
        lock (room.Gate)
        {
            previousCustomer = room.CustomerConnectionId is { } existing && existing != Context.ConnectionId
                ? existing
                : null;

            room.CustomerConnectionId = Context.ConnectionId;
            room.CustomerOfflineSince = null;
            room.ViewConsent = snapshot.ViewConsent;
            room.ControlConsent = snapshot.ControlConsent;
            room.CustomerClient = request.Client;

            room.Capabilities.Clear();
            foreach (var capability in request.Capabilities ?? [])
                room.Capabilities.Add(capability);
        }

        sessions.Register(
            Context.ConnectionId,
            new ConnectionMembership(snapshot.Id, SessionRole.Customer, null));

        if (previousCustomer is not null)
        {
            sessions.Unregister(previousCustomer);
            await Clients.Client(previousCustomer).SendAsync(
                HubMessages.Ended,
                new EndedPayload("replaced", "Support was handed over to another tab."));
        }

        requests.SetCustomerClient(snapshot.Id, request.Client);

        string? agentName;
        lock (room.Gate)
        {
            agentName = room.AgentConnectionId is null ? null : snapshot.Agent?.DisplayName ?? room.AgentName;
        }

        await Clients.Caller.SendAsync(
            HubMessages.Joined,
            new JoinedPayload(
                snapshot.Id,
                snapshot.State == SupportRequestState.Active ? SupportRequestStates.Active : SupportRequestStates.Pending,
                new ConsentPayload(snapshot.ViewConsent, snapshot.ControlConsent),
                agentName is not null,
                agentName,
                snapshot.TenantId));

        logger.LogInformation(
            "Customer joined {RequestId} (tenant {TenantId}, state {State}, client {Client}).",
            snapshot.Id, snapshot.TenantId, snapshot.StateWire, request.Client ?? "unknown");

        await events.CustomerOnlineChangedAsync(snapshot.Id, true);
    }

    /// <summary>Batched rrweb events. The only high-volume path in the service.</summary>
    public async Task CustomerEvents(CustomerEventBatch batch)
    {
        if (sessions.MembershipOf(Context.ConnectionId) is not { Role: SessionRole.Customer } membership)
            return;

        if (sessions.Find(membership.RequestId) is not { } room)
            return;

        AppendResult result;
        lock (room.Gate)
        {
            result = sessions.Append(
                room,
                batch.Seq,
                batch.Events,
                Options.MaxBacklogEvents,
                Options.MaxBacklogBytes);
        }

        if (result.Outcome is AppendOutcome.SequenceGap or AppendOutcome.BufferOverflow)
        {
            logger.LogInformation(
                "Requesting a fresh snapshot for {RequestId} ({Outcome}).",
                membership.RequestId, result.Outcome);

            if (room.Supports(CobrowseCapabilities.Resnapshot))
            {
                await Clients.Client(Context.ConnectionId)
                    .SendAsync(HubMessages.SnapshotRequest, new { reason = result.Outcome.ToString() });
            }
            else
            {
                logger.LogWarning(
                    "Client for {RequestId} does not support resnapshot-v1; the mirror will recover on the next full snapshot.",
                    membership.RequestId);
            }
        }

        if (result.Forward.Length == 0)
            return;

        await Clients
            .Group(HubGroups.RequestAgents(membership.RequestId))
            .SendAsync(HubMessages.Events, new EventsPayload(batch.Seq, result.Forward));
    }

    /// <summary>Only the customer can change consent for their own session.</summary>
    public async Task SetConsent(ConsentChange change)
    {
        if (sessions.MembershipOf(Context.ConnectionId) is not { Role: SessionRole.Customer } membership)
            return;

        var updated = await requests.SetConsentAsync(membership.RequestId, change.View, change.Control);
        if (updated is null)
            return;

        if (sessions.Find(membership.RequestId) is { } room)
        {
            lock (room.Gate)
            {
                room.ViewConsent = updated.ViewConsent;
                room.ControlConsent = updated.ControlConsent;

                if (!updated.ViewConsent)
                {
                    room.Backlog.Clear();
                    room.BacklogBytes = 0;
                    room.AwaitingSnapshot = false;
                }
            }
        }

        logger.LogInformation(
            "Consent for {RequestId}: view={View} control={Control}.",
            membership.RequestId, updated.ViewConsent, updated.ControlConsent);
    }

    // ----------------------------------------------------------------- agent

    public async Task JoinAsAgent(JoinAgentRequest request)
    {
        var agent = agents.GetCurrent(Context.GetHttpContext());

        var grant = tickets.Resolve(request.Ticket, TicketKind.Agent)
                    ?? throw new HubException("invalid-ticket");

        if (grant.RequestId != request.RequestId || grant.AgentId != agent.Id)
            throw new HubException("invalid-ticket");

        var snapshot = requests.Get(request.RequestId)
                       ?? throw new HubException("request-not-found");

        if (snapshot.IsTerminal)
            throw new HubException("request-closed");

        if (snapshot.State != SupportRequestState.Active)
            throw new HubException("request-not-active");

        if (snapshot.Agent?.Id != agent.Id)
            throw new HubException("not-assigned");

        var room = sessions.GetOrCreate(snapshot.Id);

        JsonElement[] backlog;
        bool customerOnline;
        lock (room.Gate)
        {
            room.AgentConnectionId = Context.ConnectionId;
            room.AgentName = agent.DisplayName;
            room.ViewConsent = snapshot.ViewConsent;
            room.ControlConsent = snapshot.ControlConsent;
            backlog = room.Backlog.ToArray();
            customerOnline = room.CustomerConnectionId is not null;
        }

        sessions.Register(
            Context.ConnectionId,
            new ConnectionMembership(snapshot.Id, SessionRole.Agent, agent.Id));

        await Groups.AddToGroupAsync(Context.ConnectionId, HubGroups.RequestAgents(snapshot.Id));

        await Clients.Caller.SendAsync(
            HubMessages.SessionState,
            new SessionStatePayload(
                snapshot.ToSummary(),
                new ConsentPayload(snapshot.ViewConsent, snapshot.ControlConsent),
                customerOnline,
                Options.MaxHubProtocol,
                snapshot.CustomerClient));

        for (var offset = 0; offset < backlog.Length; offset += BacklogChunkSize)
        {
            var chunk = backlog[offset..Math.Min(offset + BacklogChunkSize, backlog.Length)];
            await Clients.Caller.SendAsync(HubMessages.Backlog, new BacklogChunk(chunk));
        }

        await Clients.Caller.SendAsync(HubMessages.BacklogComplete, new BacklogComplete(backlog.Length));

        logger.LogInformation(
            "Agent {Agent} joined {RequestId} with {Count} backlog events.",
            agent.DisplayName, snapshot.Id, backlog.Length);

        await events.AgentOnlineChangedAsync(snapshot.Id, true, agent.DisplayName);
    }

    public async Task Control(ControlCommand command)
    {
        if (sessions.MembershipOf(Context.ConnectionId) is not
            { Role: SessionRole.Agent } membership)
            return;

        if (membership.RequestId != command.RequestId)
            return;

        if (!AllowedActions.Contains(command.Action))
            return;

        if (string.IsNullOrEmpty(command.NodeId) && command.Action is not ("scroll" or "scrollTo"))
            return;

        if (sessions.Find(membership.RequestId) is not { } room)
            return;

        string? customer;
        lock (room.Gate)
        {
            if (!room.ViewConsent || !room.ControlConsent)
                return;

            customer = room.CustomerConnectionId;
        }

        if (customer is null)
            return;

        await Clients.Client(customer).SendAsync(
            HubMessages.Control,
            new ControlPayload(command.NodeId, command.Action, command.Value));
    }

    public async Task Cursor(CursorCommand command)
    {
        if (sessions.MembershipOf(Context.ConnectionId) is not
            { Role: SessionRole.Agent } membership)
            return;

        if (membership.RequestId != command.RequestId)
            return;

        if (!double.IsFinite(command.X) || !double.IsFinite(command.Y))
            return;

        if (sessions.Find(membership.RequestId) is not { } room)
            return;

        string? customer;
        lock (room.Gate)
        {
            if (!room.ViewConsent)
                return;

            customer = room.CustomerConnectionId;
        }

        if (customer is null)
            return;

        await Clients.Client(customer).SendAsync(
            HubMessages.Cursor,
            new CursorPayload(
                Math.Clamp(command.X, 0, 1),
                Math.Clamp(command.Y, 0, 1),
                command.DocX,
                command.DocY));
    }

    /// <summary>Either side can end the session. The domain notifies both.</summary>
    public async Task EndSession(EndSessionCommand command)
    {
        if (sessions.MembershipOf(Context.ConnectionId) is not { } membership)
            return;

        if (!string.IsNullOrEmpty(command.RequestId) && command.RequestId != membership.RequestId)
            return;

        if (membership.Role == SessionRole.Customer)
        {
            await requests.EndAsync(
                membership.RequestId,
                "customer-ended",
                "The customer ended the support session.",
                SupportRequestState.Ended);
        }
        else
        {
            await requests.EndAsync(
                membership.RequestId,
                "agent-ended",
                "The agent ended the support session.",
                SupportRequestState.Ended);
        }
    }

    public async Task Ping()
    {
        await Task.CompletedTask;
    }

    /// <summary>Opt-in queue feed for agent clients that are not Blazor circuits.</summary>
    public Task SubscribeQueue() => Groups.AddToGroupAsync(Context.ConnectionId, HubGroups.Queue);

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var membership = sessions.Unregister(Context.ConnectionId);

        if (membership is not null)
        {
            if (membership.Role == SessionRole.Customer)
            {
                sessions.MarkCustomerOffline(membership.RequestId, Context.ConnectionId);
                await events.CustomerOnlineChangedAsync(membership.RequestId, false);
            }
            else
            {
                sessions.MarkAgentOffline(membership.RequestId, Context.ConnectionId);
                await events.AgentOnlineChangedAsync(membership.RequestId, false, null);
            }
        }

        await base.OnDisconnectedAsync(exception);
    }
}
