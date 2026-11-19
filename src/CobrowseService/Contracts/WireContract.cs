using System.Text.Json;
using System.Text.Json.Serialization;

namespace CobrowseService.Contracts;

/// <summary>
/// Server-side view of the tenant and hub wire contracts. Deliberately a copy,
/// not a reference: <c>App.Cobrowse</c> is deployed inside independently
/// versioned tenant apps, so the two sides must agree on JSON only.
/// See docs/compatibility.md.
/// </summary>
public static class CobrowseProtocol
{
    public const int Http = 1;
    public const int Hub = 1;

    public const string ApiPrefix = "/api/v1";
    public const string HubPath = "/hubs/cobrowse";

    public const string TenantHeader = "X-Cobrowse-Tenant";
    public const string KeyHeader = "X-Cobrowse-Key";
    public const string ClientHeader = "X-Cobrowse-Client";
    public const string ProtocolHeader = "X-Cobrowse-Protocol";
}

public static class CobrowseCapabilities
{
    public const string Rrweb = "rrweb-v1";
    public const string Control = "control-v1";
    public const string Resnapshot = "resnapshot-v1";
    public const string Batching = "batch-v1";
}

public static class SupportRequestStates
{
    public const string Pending = "pending";
    public const string Active = "active";
    public const string Ended = "ended";
    public const string Expired = "expired";
    public const string Cancelled = "cancelled";
}

public static class HubGroups
{
    public const string Queue = "queue";
    public static string RequestAgents(string requestId) => $"request:{requestId}:agents";
}

public static class HubMessages
{
    // server -> customer
    public const string Joined = "joined";
    public const string AgentChanged = "agent-changed";
    public const string ConsentChanged = "consent-changed";
    public const string Control = "control";
    public const string Cursor = "cursor";
    public const string SnapshotRequest = "snapshot-request";
    public const string Ended = "ended";

    // server -> agent
    public const string SessionState = "session-state";
    public const string Backlog = "backlog";
    public const string BacklogComplete = "backlog-complete";
    public const string Events = "events";
    public const string CustomerState = "customer-state";
    public const string QueueChanged = "queue-changed";

    // client -> server
    public const string JoinAsCustomer = "JoinAsCustomer";
    public const string JoinAsAgent = "JoinAsAgent";
    public const string CustomerEvents = "CustomerEvents";
    public const string SetConsent = "SetConsent";
    public const string Ping = "Ping";
    public const string SubscribeQueue = "SubscribeQueue";
}

// ---------------------------------------------------------------- tenant API

public sealed record SupportUserDto
{
    public string Id { get; init; } = "";
    public string DisplayName { get; init; } = "";
    public string? Email { get; init; }
    public string? Locale { get; init; }
}

public sealed record SupportPageDto
{
    public string? Url { get; init; }
    public string? Title { get; init; }
}

public sealed record CreateSupportRequestRequest
{
    public SupportUserDto User { get; init; } = new();
    public SupportPageDto? Page { get; init; }
    public bool AllowControl { get; init; } = true;
    public string? Note { get; init; }
    public Dictionary<string, string>? Metadata { get; init; }
}

public sealed record ProtocolRangeDto
{
    public int Selected { get; init; }
    public int Min { get; init; }
    public int Max { get; init; }
}

public sealed record CreateSupportRequestResponse
{
    public string RequestId { get; init; } = "";
    public string JoinToken { get; init; } = "";
    public string HubUrl { get; init; } = "";
    public DateTimeOffset ExpiresAt { get; init; }
    public ProtocolRangeDto Protocol { get; init; } = new();
    public bool Reused { get; init; }
}

public sealed record SupportAgentDto
{
    public string Id { get; init; } = "";
    public string DisplayName { get; init; } = "";
}

public sealed record SupportConsentDto
{
    public bool View { get; init; }
    public bool Control { get; init; }
}

public sealed record SupportRequestStatus
{
    public string RequestId { get; init; } = "";
    public string TenantId { get; init; } = "";
    public string State { get; init; } = SupportRequestStates.Pending;
    public SupportUserDto? User { get; init; }
    public SupportAgentDto? Agent { get; init; }
    public SupportConsentDto Consent { get; init; } = new();
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? AcceptedAt { get; init; }
    public DateTimeOffset? EndedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }
    public string? EndReason { get; init; }
    public Dictionary<string, string>? Metadata { get; init; }
}

// ------------------------------------------------------------------ hub in

public sealed record JoinCustomerRequest
{
    public string Token { get; init; } = "";
    public int Protocol { get; init; } = CobrowseProtocol.Hub;
    public int MinProtocol { get; init; } = 1;
    public string[]? Capabilities { get; init; }
    public string? Client { get; init; }
}

public sealed record JoinAgentRequest
{
    public string RequestId { get; init; } = "";
    public string Ticket { get; init; } = "";
}

public sealed record CustomerEventBatch
{
    public long Seq { get; init; }
    public JsonElement[] Events { get; init; } = [];
}

public sealed record ConsentChange
{
    public bool View { get; init; } = true;
    public bool Control { get; init; }
}

public sealed record ControlCommand
{
    public string RequestId { get; init; } = "";
    public string NodeId { get; init; } = "";
    public string Action { get; init; } = "";
    public string? Value { get; init; }

    /// <summary>Extension point for future actions; ignored by protocol 1 servers.</summary>
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? Extra { get; init; }
}

public sealed record CursorCommand
{
    public string RequestId { get; init; } = "";

    /// <summary>Viewport-relative position, 0..1. Kept for protocol-1 customers.</summary>
    public double X { get; init; }
    public double Y { get; init; }

    /// <summary>
    /// Document-relative position in CSS pixels. Newer customers position the
    /// pointer absolutely in the document, so the dot stays on the same page
    /// element while either side scrolls. Optional and additive.
    /// </summary>
    public double? DocX { get; init; }
    public double? DocY { get; init; }
}

public sealed record EndSessionCommand
{
    public string RequestId { get; init; } = "";
    public string? Reason { get; init; }
}

// ----------------------------------------------------------------- hub out

public sealed record AgentChangedPayload(bool Online, string? DisplayName);

public sealed record ConsentPayload(bool View, bool Control);

public sealed record ControlPayload(string NodeId, string Action, string? Value);

public sealed record CursorPayload(double X, double Y, double? DocX = null, double? DocY = null);

public sealed record EventsPayload(long Seq, JsonElement[] Events);

public sealed record BacklogChunk(JsonElement[] Events);

public sealed record BacklogComplete(int Count);

public sealed record EndedPayload(string Reason, string? Message);

public sealed record JoinedPayload(
    string RequestId,
    string State,
    ConsentPayload Consent,
    bool AgentOnline,
    string? AgentName,
    string TenantId);

public sealed record SessionStatePayload(
    RequestSummary Request,
    ConsentPayload Consent,
    bool CustomerOnline,
    int HubProtocol,
    string? CustomerClient);

public sealed record QueueChangedPayload(string Change, RequestSummary Request);

public sealed record CustomerStatePayload(bool Online);

/// <summary>Shape of one row in the agent queue and of the session header.</summary>
public sealed record RequestSummary(
    string Id,
    string TenantId,
    string UserId,
    string UserName,
    string? UserEmail,
    string? Note,
    string? PageUrl,
    string? PageTitle,
    bool AllowControl,
    string State,
    DateTimeOffset CreatedAt,
    string? PluginVersion);
