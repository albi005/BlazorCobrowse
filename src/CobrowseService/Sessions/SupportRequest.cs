using CobrowseService.Contracts;

namespace CobrowseService.Sessions;

public enum SupportRequestState
{
    Pending,
    Active,
    Ended,
    Expired,
    Cancelled
}

/// <summary>Immutable view of a request, safe to hand to Blazor components and the wire.</summary>
public sealed record SupportRequestSnapshot(
    string Id,
    string TenantId,
    SupportUserDto User,
    SupportPageDto? Page,
    string? Note,
    IReadOnlyDictionary<string, string> Metadata,
    bool AllowControl,
    SupportRequestState State,
    bool ViewConsent,
    bool ControlConsent,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? AcceptedAt,
    DateTimeOffset? EndedAt,
    SupportAgentDto? Agent,
    string? EndReasonCode,
    string? EndReason,
    string? CustomerClient)
{
    public string StateWire => State switch
    {
        SupportRequestState.Pending => SupportRequestStates.Pending,
        SupportRequestState.Active => SupportRequestStates.Active,
        SupportRequestState.Expired => SupportRequestStates.Expired,
        SupportRequestState.Cancelled => SupportRequestStates.Cancelled,
        _ => SupportRequestStates.Ended
    };

    public bool IsTerminal => State is SupportRequestState.Ended
        or SupportRequestState.Expired
        or SupportRequestState.Cancelled;

    public SupportRequestStatus ToStatus() => new()
    {
        RequestId = Id,
        TenantId = TenantId,
        State = StateWire,
        User = User,
        Agent = Agent,
        Consent = new SupportConsentDto { View = ViewConsent, Control = ControlConsent },
        CreatedAt = CreatedAt,
        AcceptedAt = AcceptedAt,
        EndedAt = EndedAt,
        ExpiresAt = ExpiresAt,
        EndReason = EndReason,
        Metadata = Metadata.Count == 0 ? null : new Dictionary<string, string>(Metadata),
    };

    public RequestSummary ToSummary() => new(
        Id,
        TenantId,
        User.Id,
        User.DisplayName,
        User.Email,
        Note,
        Page?.Url,
        Page?.Title,
        AllowControl,
        StateWire,
        CreatedAt,
        CustomerClient);
}

/// <summary>
/// Mutable entity. Only touched under <see cref="Gate"/>; everything that leaves
/// the store is a <see cref="SupportRequestSnapshot"/>.
/// </summary>
public sealed class SupportRequestEntity
{
    public required string Id { get; init; }
    public required string TenantId { get; init; }
    public required SupportUserDto User { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public object Gate { get; } = new();

    public SupportPageDto? Page { get; set; }
    public string? Note { get; set; }
    public Dictionary<string, string> Metadata { get; set; } = new();
    public bool AllowControl { get; set; } = true;
    public DateTimeOffset ExpiresAt { get; set; }

    public SupportRequestState State { get; set; } = SupportRequestState.Pending;
    public bool ViewConsent { get; set; } = true;
    public bool ControlConsent { get; set; }
    public DateTimeOffset? AcceptedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public SupportAgentDto? Agent { get; set; }
    public string? EndReasonCode { get; set; }
    public string? EndReason { get; set; }
    public string? CustomerClient { get; set; }

    public SupportRequestSnapshot ToSnapshot() => new(
        Id,
        TenantId,
        User,
        Page,
        Note,
        new Dictionary<string, string>(Metadata, StringComparer.Ordinal),
        AllowControl,
        State,
        ViewConsent,
        ControlConsent,
        CreatedAt,
        ExpiresAt,
        AcceptedAt,
        EndedAt,
        Agent,
        EndReasonCode,
        EndReason,
        CustomerClient);
}
