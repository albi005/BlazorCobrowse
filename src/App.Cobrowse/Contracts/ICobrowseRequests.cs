using Cobrowse.Contracts;

namespace Cobrowse;

/// <summary>
/// Server-to-server facade over the cobrowse service HTTP API. Call it from a
/// Blazor circuit: the tenant API key must never reach the browser, which is
/// why the plugin never lets the page talk to this API directly.
/// </summary>
public interface ICobrowseRequests
{
    Task<CreateSupportRequestResponse> CreateAsync(
        SupportUserDto user,
        SupportPageDto? page = null,
        string? note = null,
        bool allowControl = true,
        CancellationToken cancellationToken = default);

    /// <summary>Returns <c>null</c> when the service does not know the request.</summary>
    Task<SupportRequestStatus?> GetAsync(string requestId, CancellationToken cancellationToken = default);

    Task CancelAsync(string requestId, CancellationToken cancellationToken = default);
}

public class CobrowseException : Exception
{
    public CobrowseException(string message, Exception? inner = null) : base(message, inner) { }
}

/// <summary>The service could not be reached, timed out, or returned a 5xx.</summary>
public sealed class CobrowseUnavailableException(string message, Exception? inner = null)
    : CobrowseException(message, inner);

/// <summary>Tenant id or key rejected by the service.</summary>
public sealed class CobrowseUnauthorizedException(string message)
    : CobrowseException(message);

/// <summary>
/// The service no longer supports this plugin's protocol version. The page
/// should stop offering support and tell the user to reload / contact support,
/// rather than retrying forever.
/// </summary>
public sealed class CobrowseProtocolUnsupportedException(int minSupported, int maxSupported)
    : CobrowseException($"The support service requires protocol {minSupported}-{maxSupported}; this application speaks protocol {CobrowseProtocol.Http}.")
{
    public int MinSupported { get; } = minSupported;
    public int MaxSupported { get; } = maxSupported;
}

/// <summary>Any other non-success response, carrying the service's problem code.</summary>
public sealed class CobrowseApiException(
    System.Net.HttpStatusCode status,
    string? code,
    string message,
    string? requestId = null)
    : CobrowseException(message)
{
    public System.Net.HttpStatusCode Status { get; } = status;
    public string? Code { get; } = code;
    public string? RequestId { get; } = requestId;
}
