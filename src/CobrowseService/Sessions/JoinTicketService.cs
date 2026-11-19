using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace CobrowseService.Sessions;

public enum TicketKind
{
    Customer,
    Agent
}

public sealed record TicketGrant(string RequestId, TicketKind Kind, string? AgentId, DateTimeOffset ExpiresAt);

/// <summary>
/// Opaque, single-request credentials. The browser never sees the tenant API
/// key; it gets a ticket that only grants access to its own request.
///
/// Tickets are stored hashed, are revocable per request, and expire with the
/// request. Agent tickets are minted per session page by the Blazor UI and are
/// replaced by a real signed assertion once LDAP/OIDC lands.
/// </summary>
public sealed class JoinTicketService(TimeProvider time)
{
    private readonly ConcurrentDictionary<string, TicketGrant> _grants = new(StringComparer.Ordinal);

    public string Issue(string requestId, TicketKind kind, string? agentId, TimeSpan lifetime)
    {
        var token = Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        _grants[Hash(token)] = new TicketGrant(requestId, kind, agentId, time.GetUtcNow() + lifetime);
        return token;
    }

    public TicketGrant? Resolve(string? token, TicketKind kind)
    {
        if (string.IsNullOrWhiteSpace(token))
            return null;

        var hash = Hash(token);
        if (!_grants.TryGetValue(hash, out var grant))
            return null;

        if (grant.ExpiresAt <= time.GetUtcNow())
        {
            _grants.TryRemove(hash, out _);
            return null;
        }

        return grant.Kind == kind ? grant : null;
    }

    /// <summary>Invalidate every ticket for a request (session ended, or a new tab took it over).</summary>
    public void RevokeAll(string requestId)
    {
        foreach (var pair in _grants)
        {
            if (pair.Value.RequestId == requestId)
                _grants.TryRemove(pair.Key, out _);
        }
    }

    public void SweepExpired()
    {
        var now = time.GetUtcNow();
        foreach (var pair in _grants)
        {
            if (pair.Value.ExpiresAt <= now)
                _grants.TryRemove(pair.Key, out _);
        }
    }

    private static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
