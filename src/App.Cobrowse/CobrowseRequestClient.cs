using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cobrowse.Contracts;

namespace Cobrowse;

/// <summary>
/// Thin, dependency-free HTTP client. Deliberately does not share an assembly
/// with <c>CobrowseService</c>: the two sides are deployed independently and
/// must agree on JSON, not on types. See docs/compatibility.md.
/// </summary>
internal sealed class CobrowseRequestClient(HttpClient http) : ICobrowseRequests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static string RequestsPath => CobrowseProtocol.ApiPrefix + "/support-requests";

    public async Task<CreateSupportRequestResponse> CreateAsync(
        SupportUserDto user,
        SupportPageDto? page = null,
        string? note = null,
        bool allowControl = true,
        CancellationToken cancellationToken = default)
    {
        var payload = new CreateSupportRequestRequest
        {
            User = user,
            Page = page,
            Note = note,
            AllowControl = allowControl
        };

        using var response = await SendAsync(
            () => http.PostAsJsonAsync(RequestsPath, payload, Json, cancellationToken),
            cancellationToken).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
            throw await CreateExceptionAsync(response, cancellationToken).ConfigureAwait(false);

        return await response.Content.ReadFromJsonAsync<CreateSupportRequestResponse>(Json, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new CobrowseUnavailableException("The support service returned an empty response.");
    }

    public async Task<SupportRequestStatus?> GetAsync(string requestId, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(
            () => http.GetAsync($"{RequestsPath}/{Uri.EscapeDataString(requestId)}", cancellationToken),
            cancellationToken).ConfigureAwait(false);

        if (response.StatusCode == HttpStatusCode.NotFound)
            return null;

        if (!response.IsSuccessStatusCode)
            throw await CreateExceptionAsync(response, cancellationToken).ConfigureAwait(false);

        return await response.Content.ReadFromJsonAsync<SupportRequestStatus>(Json, cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task CancelAsync(string requestId, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(
            () => http.PostAsync($"{RequestsPath}/{Uri.EscapeDataString(requestId)}/cancel", content: null, cancellationToken),
            cancellationToken).ConfigureAwait(false);

        if (response.IsSuccessStatusCode)
            return;

        // Cancelling an already-ended request is not an error the caller can act on.
        if (response.StatusCode == HttpStatusCode.Conflict)
            return;

        throw await CreateExceptionAsync(response, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<HttpResponseMessage> SendAsync(
        Func<Task<HttpResponseMessage>> send,
        CancellationToken cancellationToken)
    {
        try
        {
            return await send().ConfigureAwait(false);
        }
        catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            throw new CobrowseUnavailableException("The support service did not respond in time.", ex);
        }
        catch (HttpRequestException ex)
        {
            throw new CobrowseUnavailableException("The support service is unreachable.", ex);
        }
    }

    private static async Task<Exception> CreateExceptionAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        CobrowseProblem? problem = null;
        try
        {
            problem = await response.Content
                .ReadFromJsonAsync<CobrowseProblem>(Json, cancellationToken)
                .ConfigureAwait(false);
        }
        catch
        {
            // Non-JSON error body (proxy, gateway). Fall through to a generic error.
        }

        var message = problem?.Detail ?? problem?.Title ?? $"Cobrowse service returned {(int)response.StatusCode}.";

        if (response.StatusCode == HttpStatusCode.UpgradeRequired)
            return new CobrowseProtocolUnsupportedException(
                problem?.MinSupported ?? CobrowseProtocol.Http + 1,
                problem?.MaxSupported ?? CobrowseProtocol.Http + 1);

        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            return new CobrowseUnauthorizedException(message);

        if ((int)response.StatusCode >= 500)
            return new CobrowseUnavailableException(message);

        return new CobrowseApiException(response.StatusCode, problem?.Code, message, problem?.RequestId);
    }
}
