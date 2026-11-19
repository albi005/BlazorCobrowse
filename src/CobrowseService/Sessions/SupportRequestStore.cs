using System.Collections.Concurrent;

namespace CobrowseService.Sessions;

public interface ISupportRequestStore
{
    SupportRequestSnapshot? Get(string id);

    /// <summary>An existing request this user could still attach to (pending or active).</summary>
    SupportRequestSnapshot? FindLiveFor(string tenantId, string userId);

    IReadOnlyList<SupportRequestSnapshot> List();

    IReadOnlyList<SupportRequestSnapshot> ListPending();

    IReadOnlyList<SupportRequestSnapshot> ListActiveForAgent(string agentId);

    SupportRequestSnapshot Add(SupportRequestEntity entity);

    /// <summary>
    /// Mutates atomically. The callback returns <c>false</c> to reject the change;
    /// the returned snapshot is then the unchanged state (or <c>null</c> if the
    /// request is gone).
    /// </summary>
    SupportRequestSnapshot? Update(string id, Func<SupportRequestEntity, bool> mutate);

    bool Remove(string id);
}

/// <summary>
/// Process-local store. Correct for a single service instance, which is the
/// current deployment model. For scale-out, replace with Redis (the entity is
/// already a flat record with no in-process references) and add the SignalR
/// Redis backplane — no other code changes.
/// </summary>
public sealed class InMemorySupportRequestStore : ISupportRequestStore
{
    private readonly ConcurrentDictionary<string, SupportRequestEntity> _requests = new(StringComparer.Ordinal);

    public SupportRequestSnapshot? Get(string id) =>
        _requests.TryGetValue(id, out var entity) ? SnapshotOf(entity) : null;

    public SupportRequestSnapshot? FindLiveFor(string tenantId, string userId) =>
        _requests.Values
            .Select(SnapshotOf)
            .Where(r => r.State is SupportRequestState.Pending or SupportRequestState.Active)
            .Where(r => r.TenantId == tenantId && r.User.Id == userId)
            .OrderByDescending(r => r.CreatedAt)
            .FirstOrDefault();

    public IReadOnlyList<SupportRequestSnapshot> List() =>
        _requests.Values.Select(SnapshotOf).OrderBy(r => r.CreatedAt).ToArray();

    public IReadOnlyList<SupportRequestSnapshot> ListPending() =>
        _requests.Values
            .Select(SnapshotOf)
            .Where(r => r.State == SupportRequestState.Pending)
            .OrderBy(r => r.CreatedAt)
            .ToArray();

    public IReadOnlyList<SupportRequestSnapshot> ListActiveForAgent(string agentId) =>
        _requests.Values
            .Select(SnapshotOf)
            .Where(r => r.State == SupportRequestState.Active && r.Agent?.Id == agentId)
            .OrderByDescending(r => r.AcceptedAt)
            .ToArray();

    public SupportRequestSnapshot Add(SupportRequestEntity entity)
    {
        _requests[entity.Id] = entity;
        return SnapshotOf(entity);
    }

    public SupportRequestSnapshot? Update(string id, Func<SupportRequestEntity, bool> mutate)
    {
        if (!_requests.TryGetValue(id, out var entity))
            return null;

        lock (entity.Gate)
        {
            mutate(entity);
            return entity.ToSnapshot();
        }
    }

    public bool Remove(string id) => _requests.TryRemove(id, out _);

    private static SupportRequestSnapshot SnapshotOf(SupportRequestEntity entity)
    {
        lock (entity.Gate)
        {
            return entity.ToSnapshot();
        }
    }
}
