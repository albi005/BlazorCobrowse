using System.Security.Claims;
using Cobrowse.Contracts;

namespace Cobrowse;

/// <summary>
/// Where the plugin gets the customer's identity for the support request. The
/// default implementation reads standard OIDC claims, which is what a Google
/// SSO login produces once the tenant app is wired up.
/// </summary>
public interface ICobrowseUserProvider
{
    SupportUserDto GetUser(ClaimsPrincipal? principal);
}

public sealed class ClaimsCobrowseUserProvider : ICobrowseUserProvider
{
    public SupportUserDto GetUser(ClaimsPrincipal? principal)
    {
        if (principal?.Identity?.IsAuthenticated != true)
        {
            return new SupportUserDto
            {
                Id = "anonymous",
                DisplayName = "Unknown user"
            };
        }

        var id = principal.FindFirstValue(ClaimTypes.NameIdentifier)
                 ?? principal.FindFirstValue("sub")
                 ?? principal.FindFirstValue(ClaimTypes.Email)
                 ?? principal.Identity.Name
                 ?? "unknown";

        var name = principal.FindFirstValue("name")
                   ?? principal.FindFirstValue(ClaimTypes.Name)
                   ?? principal.FindFirstValue(ClaimTypes.Email)
                   ?? id;

        return new SupportUserDto
        {
            Id = id,
            DisplayName = name,
            Email = principal.FindFirstValue(ClaimTypes.Email) ?? principal.FindFirstValue("email"),
            Locale = principal.FindFirstValue("locale")
        };
    }
}
