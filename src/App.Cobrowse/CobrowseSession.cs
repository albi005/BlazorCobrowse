using System.Security.Claims;
using System.Text.Json.Serialization;
using Cobrowse.Contracts;
using Microsoft.AspNetCore.Components;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.JSInterop;

namespace Cobrowse;

public enum CobrowseUiState
{
    Idle,
    Creating,
    Waiting,
    Connected,
    Ended,
    Error
}

/// <summary>Render state for the support button. Immutable so a component can diff it cheaply.</summary>
public sealed record CobrowseSessionSnapshot(
    CobrowseUiState State,
    string? RequestId,
    string? AgentName,
    bool View,
    bool Control,
    string? Message)
{
    public static readonly CobrowseSessionSnapshot Idle =
        new(CobrowseUiState.Idle, null, null, false, false, null);

    public bool HasLiveRequest => State is CobrowseUiState.Creating or CobrowseUiState.Waiting or CobrowseUiState.Connected;
}

/// <summary>Payload pushed from <c>cobrowse-client.js</c> whenever the browser-side session changes.</summary>
public sealed class JsCobrowseState
{
    public string? State { get; set; }
    public string? Message { get; set; }
    public string? Agent { get; set; }
    public bool View { get; set; }
    public bool Control { get; set; }
}

/// <summary>
/// Per-circuit support session. Owns the server-side request (created through
/// the trusted tenant→service call) and the browser-side tracker/transport
/// (started through JS interop). One instance per Blazor circuit, so every
/// button on the page sees the same session.
/// </summary>
public sealed class CobrowseSession : IAsyncDisposable
{
    private const string ModulePath = "./_content/App.Cobrowse/js/cobrowse-client.js";

    private readonly ICobrowseRequests _requests;
    private readonly ICobrowseUserProvider _users;
    private readonly CobrowseOptions _options;
    private readonly IJSRuntime _js;
    private readonly NavigationManager _navigation;
    private readonly ILogger<CobrowseSession> _logger;
    private readonly DotNetObjectReference<CobrowseSession> _self;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private IJSObjectReference? _module;
    private bool _disposed;

    public CobrowseSession(
        ICobrowseRequests requests,
        ICobrowseUserProvider users,
        IOptions<CobrowseOptions> options,
        IJSRuntime js,
        NavigationManager navigation,
        ILogger<CobrowseSession> logger)
    {
        _requests = requests;
        _users = users;
        _options = options.Value;
        _js = js;
        _navigation = navigation;
        _logger = logger;
        _self = DotNetObjectReference.Create(this);
    }

    public CobrowseSessionSnapshot Snapshot { get; private set; } = CobrowseSessionSnapshot.Idle;

    public event Action? Changed;

    /// <summary>Ask the support service for an agent, then attach this tab to the request.</summary>
    public async Task StartAsync(ClaimsPrincipal? principal)
    {
        await _gate.WaitAsync();
        try
        {
            if (_disposed || Snapshot.HasLiveRequest)
                return;

            SetState(Snapshot with
            {
                State = CobrowseUiState.Creating,
                Message = null,
                AgentName = null,
                RequestId = null
            });

            var user = _users.GetUser(principal);
            var page = new SupportPageDto { Url = _navigation.Uri };

            CreateSupportRequestResponse created;
            try
            {
                created = await _requests.CreateAsync(user, page, allowControl: _options.AllowControl);
            }
            catch (CobrowseProtocolUnsupportedException ex)
            {
                _logger.LogError(ex, "Cobrowse plugin protocol {Protocol} is no longer supported.", CobrowseProtocol.Http);
                SetState(Snapshot with
                {
                    State = CobrowseUiState.Error,
                    Message = "The support service was upgraded and this page needs a reload. Please refresh, or contact support directly."
                });
                return;
            }
            catch (CobrowseException ex)
            {
                _logger.LogWarning(ex, "Could not create a support request.");
                SetState(Snapshot with
                {
                    State = CobrowseUiState.Error,
                    Message = ex is CobrowseUnavailableException
                        ? "Remote support is unavailable right now. Please try again in a moment."
                        : ex.Message
                });
                return;
            }

            SetState(Snapshot with
            {
                State = CobrowseUiState.Waiting,
                RequestId = created.RequestId
            });

            try
            {
                _module ??= await _js.InvokeAsync<IJSObjectReference>("import", ModulePath);
                await _module.InvokeVoidAsync("start", new
                {
                    hubUrl = created.HubUrl,
                    requestId = created.RequestId,
                    joinToken = created.JoinToken,
                    allowControl = _options.AllowControl,
                    maskPasswords = _options.MaskPasswords,
                    protocol = CobrowseProtocol.Hub,
                    minProtocol = CobrowseProtocol.Hub,
                    client = _options.ClientHeader
                }, _self);
            }
            catch (Exception ex) when (ex is JSException or InvalidOperationException)
            {
                _logger.LogError(ex, "The browser-side cobrowse tracker failed to start.");
                await SafeCancelAsync(created.RequestId);
                SetState(Snapshot with
                {
                    State = CobrowseUiState.Error,
                    Message = "The support widget could not start in this browser."
                });
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Customer-initiated end (button in the page, or the End button in the banner).</summary>
    public async Task EndAsync()
    {
        await _gate.WaitAsync();
        try
        {
            var requestId = Snapshot.RequestId;
            if (requestId is not null)
                await SafeCancelAsync(requestId);

            await StopBrowserAsync("customer-ended");
            SetState(CobrowseSessionSnapshot.Idle);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Called by the banner in the browser. Runs the same path as the in-page button.</summary>
    [JSInvokable]
    public Task OnEndRequested() => EndAsync();

    /// <summary>Browser-side state push (agent joined, control revoked, connection lost, …).</summary>
    [JSInvokable]
    public Task OnStateChanged(JsCobrowseState state)
    {
        var mapped = state.State switch
        {
            "creating" => CobrowseUiState.Creating,
            "pending" => CobrowseUiState.Waiting,
            "active" or "connected" => CobrowseUiState.Connected,
            "ended" or "expired" or "cancelled" => CobrowseUiState.Ended,
            "error" => CobrowseUiState.Error,
            _ => Snapshot.State
        };

        SetState(Snapshot with
        {
            State = mapped,
            AgentName = state.Agent ?? Snapshot.AgentName,
            View = state.View,
            Control = state.Control,
            Message = state.Message ?? (mapped == CobrowseUiState.Connected ? null : Snapshot.Message)
        });

        return Task.CompletedTask;
    }

    private async Task SafeCancelAsync(string requestId)
    {
        try
        {
            await _requests.CancelAsync(requestId);
        }
        catch (CobrowseException ex)
        {
            // The hub may already have ended the session; that is not a failure.
            _logger.LogDebug(ex, "Cancel for {RequestId} was not accepted.", requestId);
        }
    }

    private async Task StopBrowserAsync(string reason)
    {
        if (_module is null)
            return;

        try
        {
            await _module.InvokeVoidAsync("stop", reason);
        }
        catch
        {
            // Circuit is going away or the module never loaded.
        }
    }

    private void SetState(CobrowseSessionSnapshot snapshot)
    {
        Snapshot = snapshot;
        Changed?.Invoke();
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
            return;

        _disposed = true;
        await StopBrowserAsync("circuit-disposed");
        _self.Dispose();
        _gate.Dispose();
    }
}
