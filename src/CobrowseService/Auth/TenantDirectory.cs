using System.Security.Cryptography;
using System.Text;
using CobrowseService.Contracts;
using Microsoft.Extensions.Options;

namespace CobrowseService.Auth;

public sealed class TenantOptions
{
    public string ApiKey { get; set; } = "";
    public string DisplayName { get; set; } = "";
}

public sealed class TenantsOptions
{
    public Dictionary<string, TenantOptions> Tenants { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed record TenantContext(string Id, string DisplayName);

public interface ITenantDirectory
{
    /// <summary>
    /// Authenticates the tenant from the request headers. The tenant service and
    /// the cobrowse service share a private network, so this is a shared key
    /// today; the same seam takes mTLS or a signed service token later.
    /// </summary>
    TenantContext? Authenticate(HttpRequest request);
}

public sealed class TenantDirectory(IOptions<TenantsOptions> options) : ITenantDirectory
{
    public TenantContext? Authenticate(HttpRequest request)
    {
        var tenantId = request.Headers[CobrowseProtocol.TenantHeader].ToString();
        var key = request.Headers[CobrowseProtocol.KeyHeader].ToString();

        if (string.IsNullOrWhiteSpace(tenantId) || string.IsNullOrWhiteSpace(key))
            return null;

        if (!options.Value.Tenants.TryGetValue(tenantId, out var tenant))
            return null;

        return FixedTimeEquals(key, tenant.ApiKey)
            ? new TenantContext(tenantId, string.IsNullOrWhiteSpace(tenant.DisplayName) ? tenantId : tenant.DisplayName)
            : null;
    }

    private static bool FixedTimeEquals(string supplied, string expected)
    {
        if (string.IsNullOrEmpty(expected))
            return false;

        var a = Encoding.UTF8.GetBytes(supplied);
        var b = Encoding.UTF8.GetBytes(expected);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }
}
