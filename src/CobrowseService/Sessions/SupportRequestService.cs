using System.Security.Cryptography;
using CobrowseService.Auth;
using CobrowseService.Contracts;
using CobrowseService.Realtime;
using Microsoft.Extensions.Options;

namespace CobrowseService.Sessions;

public sealed record AcceptOutcome(
    bool Success,
    SupportRequestSnapshot? Request,
    string? ErrorCode,
    string? ErrorMessage);

/// <summary>
/// Domain rules for support requests: one live request per user, an agent
/// claims a waiting request exactly once, consent is owned by the customer, and
/// every terminal transition revokes tickets and notifies both sides.
/// </summary>
public sealed class SupportRequestService(
    ISupportRequestStore store,
    JoinTicketService tickets,
    ISupportEvents events,
    IOptions<CobrowseOptions> options,
    TimeProvider time)
{
    private CobrowseOptions Options => options.Value;

    public async Task<CreateSupportRequestResponse> CreateAsync(
        CreateSupportRequestRequest request,
        TenantContext tenant,
        string hubUrl)
    {
        var now = time.GetUtcNow();

        var existing = store.FindLiveFor(tenant.Id, request.User.Id);
        if (existing is not null)
        {
            // One user, one session: hand the existing request to this tab and
            // revoke the previous tab's tickets so the two cannot fight over
            // the connection.
            tickets.RevokeAll(existing.Id);

            var refreshed = store.Update(existing.Id, entity =>
            {
                entity.Page = request.Page;
                entity.Note = request.Note;
                if (request.Metadata is { Count: > 0 })
                    entity.Metadata = new Dictionary<string, string>(request.Metadata);
                entity.CustomerClient = null;
                entity.ViewConsent = true;
                entity.ControlConsent = entity.AllowControl;
                return true;
            })!;

            await events.ConsentChangedAsync(refreshed.Id, refreshed.ViewConsent, refreshed.ControlConsent);

            return new CreateSupportRequestResponse
            {
                RequestId = refreshed.Id,
                JoinToken = tickets.Issue(refreshed.Id, TicketKind.Customer, null, Options.SessionLifetime),
                HubUrl = hubUrl,
                ExpiresAt = refreshed.ExpiresAt,
                Protocol = ProtocolRange(),
                Reused = true
            };
        }

        var entity = new SupportRequestEntity
        {
            Id = "r_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant(),
            TenantId = tenant.Id,
            User = request.User,
            Page = request.Page,
            Note = request.Note,
            Metadata = request.Metadata is { Count: > 0 }
                ? new Dictionary<string, string>(request.Metadata)
                : new Dictionary<string, string>(),
            AllowControl = request.AllowControl,
            CreatedAt = now,
            ExpiresAt = now + Options.RequestLifetime,
            // Asking for help is the consent to view. Control follows the
            // tenant's policy and can be revoked in the banner at any time.
            ViewConsent = true,
            ControlConsent = request.AllowControl
        };

        var created = store.Add(entity);

        await events.QueueChangedAsync("created", created);

        return new CreateSupportRequestResponse
        {
            RequestId = created.Id,
            JoinToken = tickets.Issue(created.Id, TicketKind.Customer, null, Options.SessionLifetime),
            HubUrl = hubUrl,
            ExpiresAt = created.ExpiresAt,
            Protocol = ProtocolRange()
        };
    }

    public SupportRequestSnapshot? Get(string id) => store.Get(id);

    public SupportRequestSnapshot? GetForTenant(string id, string tenantId) =>
        store.Get(id) is { } request && request.TenantId == tenantId ? request : null;

    public IReadOnlyList<SupportRequestSnapshot> ListPending() => store.ListPending();

    public IReadOnlyList<SupportRequestSnapshot> ListActiveForAgent(string agentId) =>
        store.ListActiveForAgent(agentId);

    public async Task<AcceptOutcome> AcceptAsync(string id, AgentIdentity agent)
    {
        var current = store.Get(id);
        if (current is null)
            return new AcceptOutcome(false, null, "not_found", "The request no longer exists.");

        if (current.State == SupportRequestState.Active)
        {
            return current.Agent?.Id == agent.Id
                ? new AcceptOutcome(true, current, null, null)
                : new AcceptOutcome(false, current, "already_claimed",
                    $"Already picked up by {current.Agent?.DisplayName ?? "another agent"}.");
        }

        if (current.State != SupportRequestState.Pending)
            return new AcceptOutcome(false, current, "not_pending", "The request is no longer waiting.");

        var now = time.GetUtcNow();
        var accepted = store.Update(id, entity =>
        {
            if (entity.State != SupportRequestState.Pending)
                return false;

            entity.State = SupportRequestState.Active;
            entity.Agent = new SupportAgentDto { Id = agent.Id, DisplayName = agent.DisplayName };
            entity.AcceptedAt = now;
            entity.ViewConsent = true;
            entity.ControlConsent = entity.AllowControl;
            return true;
        });

        if (accepted is null || accepted.State != SupportRequestState.Active)
            return new AcceptOutcome(false, accepted, "already_claimed", "Another agent picked it up first.");

        await events.QueueChangedAsync("accepted", accepted);
        return new AcceptOutcome(true, accepted, null, null);
    }

    public async Task<SupportRequestSnapshot?> SetConsentAsync(string id, bool view, bool control)
    {
        var updated = store.Update(id, entity =>
        {
            if (entity.State is not (SupportRequestState.Pending or SupportRequestState.Active))
                return false;

            entity.ViewConsent = view;
            entity.ControlConsent = view && control && entity.AllowControl;
            return true;
        });

        if (updated is null || updated.IsTerminal)
            return updated;

        await events.ConsentChangedAsync(id, updated.ViewConsent, updated.ControlConsent);
        return updated;
    }

    public async Task<SupportRequestSnapshot?> EndAsync(
        string id,
        string reasonCode,
        string? reason,
        SupportRequestState state = SupportRequestState.Ended)
    {
        var current = store.Get(id);
        if (current is null)
            return null;

        if (current.IsTerminal)
            return current;

        var now = time.GetUtcNow();
        var ended = store.Update(id, entity =>
        {
            if (entity.State is SupportRequestState.Ended
                or SupportRequestState.Expired
                or SupportRequestState.Cancelled)
                return false;

            entity.State = state;
            entity.EndedAt = now;
            entity.EndReasonCode = reasonCode;
            entity.EndReason = reason;
            entity.ViewConsent = false;
            entity.ControlConsent = false;
            return true;
        });

        if (ended is null || !ended.IsTerminal)
            return ended;

        tickets.RevokeAll(id);
        await events.EndedAsync(ended);
        return ended;
    }

    public Task<SupportRequestSnapshot?> CancelAsync(string id, string tenantId) =>
        store.Get(id) is { } request && request.TenantId == tenantId
            ? EndAsync(id, "customer-cancelled", "The customer cancelled the support request.", SupportRequestState.Cancelled)
            : Task.FromResult<SupportRequestSnapshot?>(null);

    public void SetCustomerClient(string id, string? client)
    {
        store.Update(id, entity =>
        {
            entity.CustomerClient = client;
            return true;
        });
    }

    private ProtocolRangeDto ProtocolRange() => new()
    {
        Selected = CobrowseProtocol.Http,
        Min = Options.MinHttpProtocol,
        Max = Options.MaxHttpProtocol
    };
}
