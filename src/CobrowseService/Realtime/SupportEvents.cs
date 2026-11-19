using CobrowseService.Contracts;
using CobrowseService.Sessions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace CobrowseService.Realtime;

public interface ISupportEvents
{
    Task QueueChangedAsync(string change, SupportRequestSnapshot request);
    Task EndedAsync(SupportRequestSnapshot request);
    Task ConsentChangedAsync(string requestId, bool view, bool control);
    Task AgentOnlineChangedAsync(string requestId, bool online, string? agentName);
    Task CustomerOnlineChangedAsync(string requestId, bool online);
}

/// <summary>
/// Fans lifecycle changes out to the three consumers that care: the in-process
/// Blazor queue (via <see cref="RequestNotifier"/>), agents attached to a
/// session, and the customer's browser.
/// </summary>
public sealed class SupportEvents(
    IHubContext<CobrowseHub> hub,
    SessionRegistry sessions,
    RequestNotifier notifier) : ISupportEvents
{
    public async Task QueueChangedAsync(string change, SupportRequestSnapshot request)
    {
        notifier.Publish();
        await hub.Clients
            .Group(HubGroups.Queue)
            .SendAsync(HubMessages.QueueChanged, new QueueChangedPayload(change, request.ToSummary()));
    }

    public async Task EndedAsync(SupportRequestSnapshot request)
    {
        var payload = new EndedPayload(request.EndReasonCode ?? "ended", request.EndReason);

        await hub.Clients
            .Group(HubGroups.RequestAgents(request.Id))
            .SendAsync(HubMessages.Ended, payload);

        if (sessions.Find(request.Id) is { } session)
        {
            string? customer;
            lock (session.Gate)
            {
                customer = session.CustomerConnectionId;
                session.CustomerConnectionId = null;
                session.AgentConnectionId = null;
            }

            if (customer is not null)
                await hub.Clients.Client(customer).SendAsync(HubMessages.Ended, payload);
        }

        sessions.Remove(request.Id);
        notifier.Publish();

        await hub.Clients
            .Group(HubGroups.Queue)
            .SendAsync(HubMessages.QueueChanged, new QueueChangedPayload("ended", request.ToSummary()));
    }

    public async Task ConsentChangedAsync(string requestId, bool view, bool control)
    {
        var payload = new ConsentPayload(view, control);

        await hub.Clients
            .Group(HubGroups.RequestAgents(requestId))
            .SendAsync(HubMessages.ConsentChanged, payload);

        if (sessions.Find(requestId) is { } session)
        {
            string? customer;
            lock (session.Gate)
            {
                customer = session.CustomerConnectionId;
            }

            if (customer is not null)
                await hub.Clients.Client(customer).SendAsync(HubMessages.ConsentChanged, payload);
        }

        notifier.Publish();
    }

    public async Task AgentOnlineChangedAsync(string requestId, bool online, string? agentName)
    {
        if (sessions.Find(requestId) is { } session)
        {
            string? customer;
            lock (session.Gate)
            {
                customer = session.CustomerConnectionId;
            }

            if (customer is not null)
                await hub.Clients.Client(customer)
                    .SendAsync(HubMessages.AgentChanged, new AgentChangedPayload(online, agentName));
        }

        notifier.Publish();
    }

    public async Task CustomerOnlineChangedAsync(string requestId, bool online)
    {
        await hub.Clients
            .Group(HubGroups.RequestAgents(requestId))
            .SendAsync(HubMessages.CustomerState, new CustomerStatePayload(online));

        notifier.Publish();
    }
}
