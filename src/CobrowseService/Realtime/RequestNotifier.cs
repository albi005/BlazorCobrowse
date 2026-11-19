namespace CobrowseService.Realtime;

/// <summary>
/// In-process change signal for the Blazor agent UI. The hub is the source of
/// truth for browser clients; Blazor Server circuits live in the same process,
/// so a plain event avoids a second SignalR hop per queue change.
/// </summary>
public sealed class RequestNotifier
{
    public event Action? Changed;

    public void Publish() => Changed?.Invoke();
}
