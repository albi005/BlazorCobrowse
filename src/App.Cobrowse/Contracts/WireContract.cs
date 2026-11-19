using System.Text.Json.Serialization;

namespace Cobrowse.Contracts;

/// <summary>
/// Wire contract between a tenant app (this plugin) and <c>CobrowseService</c>.
///
/// Compatibility rules — see docs/compatibility.md:
///   * HTTP is versioned by path segment (<c>/api/v1</c>). A new major version
///     gets a new path; v1 handlers stay alive while any tenant uses them.
///   * Within a version, changes are additive only. Never rename or remove a
///     property, hub method or message name.
///   * Unknown JSON properties are ignored on both sides, so a newer peer's
///     extra fields are harmless.
///   * Enumerations travel as strings, and receivers must tolerate values they
///     do not know (treat an unknown state as terminal, not as an error).
/// </summary>
public static class CobrowseProtocol
{
    /// <summary>REST contract major version. Mirrors the <c>/api/v1</c> path.</summary>
    public const int Http = 1;

    /// <summary>SignalR contract major version, sent in the join message.</summary>
    public const int Hub = 1;

    /// <summary>Oldest HTTP version this client can talk to.</summary>
    public const int HttpMin = 1;

    public const string ApiPrefix = "/api/v1";
    public const string HubPath = "/hubs/cobrowse";

    public const string TenantHeader = "X-Cobrowse-Tenant";
    public const string KeyHeader = "X-Cobrowse-Key";
    public const string ClientHeader = "X-Cobrowse-Client";
    public const string ProtocolHeader = "X-Cobrowse-Protocol";
}

/// <summary>
/// Optional capabilities exchanged on hub join. The server only sends traffic a
/// client has announced, and treats an empty list as "protocol 1 baseline"
/// (rrweb events + control + consent). That is what makes an old plugin work
/// against a new service without a version check.
/// </summary>
public static class CobrowseCapabilities
{
    /// <summary>Baseline, implied for every protocol-1 client.</summary>
    public const string Rrweb = "rrweb-v1";
    public const string Control = "control-v1";

    /// <summary>The service may ask the page for a fresh full snapshot.</summary>
    public const string Resnapshot = "resnapshot-v1";

    /// <summary>Events are delivered in arrays rather than one per message.</summary>
    public const string Batching = "batch-v1";

    public static readonly string[] All = [Rrweb, Control, Resnapshot, Batching];
}

/// <summary>Wire values for <c>state</c>. Unknown values must be treated as terminal.</summary>
public static class SupportRequestStates
{
    public const string Pending = "pending";
    public const string Active = "active";
    public const string Ended = "ended";
    public const string Expired = "expired";
    public const string Cancelled = "cancelled";

    public static bool IsTerminal(string? state) =>
        state is Ended or Expired or Cancelled;
}

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

    /// <summary>
    /// Request control at the same time as viewing. The customer can still
    /// revoke it from the on-page banner; <c>false</c> means view-only.
    /// </summary>
    public bool AllowControl { get; init; } = true;

    /// <summary>Optional free-text note shown in the agent queue.</summary>
    public string? Note { get; init; }

    /// <summary>Tenant-specific key/value pairs echoed back on the status endpoint.</summary>
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

    /// <summary>Opaque, single-request credential for the browser's hub connection.</summary>
    public string JoinToken { get; init; } = "";

    /// <summary>Absolute hub URL the browser should connect to.</summary>
    public string HubUrl { get; init; } = "";

    public DateTimeOffset ExpiresAt { get; init; }
    public ProtocolRangeDto Protocol { get; init; } = new();

    /// <summary>
    /// True when the same user already had a live request and it was handed to
    /// this tab instead of creating a second one.
    /// </summary>
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

/// <summary>
/// Status envelope. <see cref="State"/> stays a string so that a new state added
/// by a newer service does not break an older plugin.
/// </summary>
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

/// <summary>Problem+json body returned by the service for non-success responses.</summary>
public sealed record CobrowseProblem
{
    public string? Code { get; init; }
    public string? Title { get; init; }
    public string? Detail { get; init; }
    public int? MinSupported { get; init; }
    public int? MaxSupported { get; init; }
    public string? RequestId { get; init; }
}
