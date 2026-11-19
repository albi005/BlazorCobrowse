using System.Collections.Concurrent;
using System.Text.Json;

namespace CobrowseService.Realtime;

public enum SessionRole
{
    Customer,
    Agent
}

public sealed record ConnectionMembership(string RequestId, SessionRole Role, string? AgentId);

/// <summary>
/// Data-plane state for one live request: who is attached, what the consent
/// state is, and the event backlog a late-joining agent needs.
///
/// A full rrweb snapshot is a baseline: when one arrives, everything before it
/// is obsolete, so the backlog is simply reset to that snapshot. That is what
/// makes reconnects and late joins cheap and correct.
/// </summary>
public sealed class LiveSession(string requestId)
{
    public string RequestId { get; } = requestId;
    public object Gate { get; } = new();

    public string? CustomerConnectionId { get; set; }
    public string? AgentConnectionId { get; set; }
    public string? AgentName { get; set; }

    public List<JsonElement> Backlog { get; } = [];
    public long BacklogBytes { get; set; }
    public long LastSeq { get; set; }

    public HashSet<string> Capabilities { get; } = new(StringComparer.Ordinal);
    public string? CustomerClient { get; set; }

    public bool ViewConsent { get; set; } = true;
    public bool ControlConsent { get; set; }
    public bool AwaitingSnapshot { get; set; }
    public DateTimeOffset? CustomerOfflineSince { get; set; }

    public bool Supports(string capability) => Capabilities.Contains(capability);
}

public enum AppendOutcome
{
    Appended,
    SnapshotBaseline,
    SequenceGap,
    BufferOverflow,
    AwaitingSnapshot
}

public readonly record struct AppendResult(AppendOutcome Outcome, JsonElement[] Forward);

public sealed class SessionRegistry(TimeProvider time)
{
    private readonly ConcurrentDictionary<string, LiveSession> _sessions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ConnectionMembership> _connections = new(StringComparer.Ordinal);

    public LiveSession GetOrCreate(string requestId) =>
        _sessions.GetOrAdd(requestId, id => new LiveSession(id));

    public LiveSession? Find(string requestId) =>
        _sessions.TryGetValue(requestId, out var session) ? session : null;

    public void Remove(string requestId) => _sessions.TryRemove(requestId, out _);

    public IEnumerable<LiveSession> All => _sessions.Values;

    public void Register(string connectionId, ConnectionMembership membership) =>
        _connections[connectionId] = membership;

    public ConnectionMembership? Unregister(string connectionId) =>
        _connections.TryRemove(connectionId, out var membership) ? membership : null;

    public ConnectionMembership? MembershipOf(string connectionId) =>
        _connections.TryGetValue(connectionId, out var membership) ? membership : null;

    /// <summary>
    /// Append a customer batch to the room and decide what the agents should see.
    /// Caller holds <see cref="LiveSession.Gate"/>.
    /// </summary>
    public AppendResult Append(
        LiveSession session,
        long seq,
        JsonElement[] events,
        int maxEvents,
        long maxBytes)
    {
        var outcome = AppendOutcome.Appended;

        if (session.LastSeq != 0 && seq != session.LastSeq + 1)
        {
            // A batch was lost (tab was backgrounded, socket flapped, …).
            // Incrementals over a broken history produce a wrong mirror, so ask
            // for a fresh snapshot instead.
            session.Backlog.Clear();
            session.BacklogBytes = 0;
            session.AwaitingSnapshot = true;
            outcome = AppendOutcome.SequenceGap;
        }

        session.LastSeq = seq;

        var start = 0;
        var snapshotIndex = -1;
        for (var i = events.Length - 1; i >= 0; i--)
        {
            if (IsFullSnapshot(events[i]))
            {
                snapshotIndex = i;
                break;
            }
        }

        if (snapshotIndex >= 0)
        {
            // A full snapshot is a new baseline, but the Meta event that
            // precedes it carries the viewport size the replayer needs to size
            // its iframe. Keep the most recent Meta event, from this batch or
            // from the backlog, and drop everything else before the snapshot.
            var existingMeta = FindLastMeta(session.Backlog);
            var batchMetaIndex = FindLastMetaIndex(events, snapshotIndex);

            session.Backlog.Clear();
            session.BacklogBytes = 0;
            session.AwaitingSnapshot = false;

            if (batchMetaIndex >= 0)
            {
                start = batchMetaIndex;
            }
            else
            {
                start = snapshotIndex;

                if (existingMeta is { } meta)
                {
                    session.Backlog.Add(meta);
                    session.BacklogBytes += meta.GetRawText().Length;
                }
            }

            outcome = AppendOutcome.SnapshotBaseline;
        }
        else if (session.AwaitingSnapshot)
        {
            // Still waiting for the requested baseline. Forward anyway: agents
            // that are already attached keep following live events, and agents
            // that just joined will queue until the snapshot lands.
            return new AppendResult(AppendOutcome.AwaitingSnapshot, events);
        }

        for (var i = start; i < events.Length; i++)
        {
            session.Backlog.Add(events[i]);
            session.BacklogBytes += events[i].GetRawText().Length;
        }

        if (session.Backlog.Count > maxEvents || session.BacklogBytes > maxBytes)
        {
            session.Backlog.Clear();
            session.BacklogBytes = 0;
            session.AwaitingSnapshot = true;
            outcome = AppendOutcome.BufferOverflow;
        }

        return new AppendResult(outcome, events);
    }

    public void MarkCustomerOffline(string requestId, string connectionId)
    {
        if (Find(requestId) is not { } session)
            return;

        lock (session.Gate)
        {
            if (session.CustomerConnectionId == connectionId)
            {
                session.CustomerConnectionId = null;
                session.CustomerOfflineSince = time.GetUtcNow();
            }
        }
    }

    public void MarkAgentOffline(string requestId, string connectionId)
    {
        if (Find(requestId) is not { } session)
            return;

        lock (session.Gate)
        {
            if (session.AgentConnectionId == connectionId)
            {
                session.AgentConnectionId = null;
                session.AgentName = null;
            }
        }
    }

    private static bool IsFullSnapshot(JsonElement element) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty("type", out var type)
        && type.ValueKind == JsonValueKind.Number
        && type.TryGetInt32(out var value)
        && value == 2; // rrweb EventType.FullSnapshot

    private static bool IsMeta(JsonElement element) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty("type", out var type)
        && type.ValueKind == JsonValueKind.Number
        && type.TryGetInt32(out var value)
        && value == 4; // rrweb EventType.Meta

    private static JsonElement? FindLastMeta(IReadOnlyList<JsonElement> events)
    {
        for (var i = events.Count - 1; i >= 0; i--)
        {
            if (IsMeta(events[i]))
                return events[i];
        }

        return null;
    }

    private static int FindLastMetaIndex(JsonElement[] events, int beforeIndex)
    {
        for (var i = beforeIndex - 1; i >= 0; i--)
        {
            if (IsMeta(events[i]))
                return i;
        }

        return -1;
    }
}
