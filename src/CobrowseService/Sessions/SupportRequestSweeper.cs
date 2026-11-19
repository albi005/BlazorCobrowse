using CobrowseService.Auth;
using CobrowseService.Contracts;
using CobrowseService.Realtime;
using Microsoft.Extensions.Options;

namespace CobrowseService.Sessions;

/// <summary>
/// Housekeeping that no request owns: queue expiry, session ceilings, the
/// customer-disconnect grace window, and retention of finished records.
/// </summary>
public sealed class SupportRequestSweeper(
    ISupportRequestStore store,
    SupportRequestService requests,
    SessionRegistry sessions,
    JoinTicketService tickets,
    IOptions<CobrowseOptions> options,
    TimeProvider time,
    ILogger<SupportRequestSweeper> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Cobrowse sweep failed.");
            }
        }
    }

    internal async Task SweepAsync(CancellationToken cancellationToken)
    {
        var optionsValue = options.Value;
        var now = time.GetUtcNow();

        foreach (var request in store.List())
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (request.IsTerminal)
            {
                if (request.EndedAt is { } endedAt && now - endedAt > optionsValue.RetentionAfterEnd)
                {
                    store.Remove(request.Id);
                    sessions.Remove(request.Id);
                }

                continue;
            }

            if (request.State == SupportRequestState.Pending)
            {
                if (now >= request.ExpiresAt)
                {
                    await requests.EndAsync(
                        request.Id,
                        "expired",
                        "No agent picked up the request in time.",
                        SupportRequestState.Expired);
                    continue;
                }

                if (HasCustomerTimedOut(request.Id, now, optionsValue.CustomerDisconnectGrace))
                {
                    await requests.EndAsync(
                        request.Id,
                        "customer-disconnected",
                        "The customer's browser disconnected.",
                        SupportRequestState.Cancelled);
                }

                continue;
            }

            if (request.State == SupportRequestState.Active)
            {
                if (now >= request.CreatedAt + optionsValue.SessionLifetime)
                {
                    await requests.EndAsync(
                        request.Id,
                        "expired",
                        "The session reached its maximum duration.",
                        SupportRequestState.Expired);
                    continue;
                }

                if (HasCustomerTimedOut(request.Id, now, optionsValue.CustomerDisconnectGrace))
                {
                    await requests.EndAsync(
                        request.Id,
                        "customer-disconnected",
                        "The customer's browser disconnected.",
                        SupportRequestState.Cancelled);
                }
            }
        }

        tickets.SweepExpired();
    }

    private bool HasCustomerTimedOut(string requestId, DateTimeOffset now, TimeSpan grace)
    {
        if (sessions.Find(requestId) is not { } session)
            return false;

        DateTimeOffset? offlineSince;
        lock (session.Gate)
        {
            offlineSince = session.CustomerOfflineSince;
        }

        return offlineSince is { } offline && now - offline > grace;
    }
}
