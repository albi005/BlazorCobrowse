using System.Security.Claims;
using Microsoft.Extensions.Options;

namespace CobrowseService.Auth;

public sealed class AgentOptions
{
    public string Id { get; set; } = "agent-1";
    public string DisplayName { get; set; } = "Support Agent";
    public string? Email { get; set; }
}

public sealed record AgentIdentity(string Id, string DisplayName, string? Email, string Source);

/// <summary>
/// The single place the agent identity enters the system. Today it reads the
/// dev agent from configuration (and honours claims if something upstream
/// authenticated the request). LDAP — or an SSO proxy that front-runs the
/// service — replaces this implementation without touching the hub or the UI.
/// </summary>
public interface IAgentIdentityProvider
{
    AgentIdentity GetCurrent(HttpContext? httpContext = null);
}

public sealed class AgentIdentityProvider(
    IHttpContextAccessor accessor,
    IOptions<AgentOptions> options) : IAgentIdentityProvider
{
    public AgentIdentity GetCurrent(HttpContext? httpContext = null)
    {
        var context = httpContext ?? accessor.HttpContext;
        var user = context?.User;

        if (user?.Identity?.IsAuthenticated == true)
        {
            var name = user.FindFirstValue("name")
                       ?? user.FindFirstValue(ClaimTypes.Name)
                       ?? user.Identity.Name
                       ?? options.Value.DisplayName;

            return new AgentIdentity(
                user.FindFirstValue(ClaimTypes.NameIdentifier) ?? user.FindFirstValue("sub") ?? name,
                name,
                user.FindFirstValue(ClaimTypes.Email),
                "claims");
        }

        return new AgentIdentity(
            options.Value.Id,
            options.Value.DisplayName,
            options.Value.Email,
            "dev");
    }
}
