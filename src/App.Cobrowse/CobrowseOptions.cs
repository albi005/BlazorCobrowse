using System.Reflection;

namespace Cobrowse;

/// <summary>
/// Settings a tenant app passes to <see cref="CobrowseServiceCollectionExtensions.AddCobrowse"/>.
/// Every value is expected to come from configuration, never from user input.
/// </summary>
public sealed class CobrowseOptions
{
    /// <summary>
    /// Base URL of the cobrowse service as seen <em>from this server</em>
    /// (same private network, no public ingress needed). Example:
    /// <c>http://cobrowse.internal:5199</c>.
    /// </summary>
    public string ServiceBaseUrl { get; set; } = "";

    /// <summary>Tenant identifier issued by the cobrowse team, e.g. <c>acme</c>.</summary>
    public string TenantId { get; set; } = "";

    /// <summary>Shared tenant key. Server-to-server only; never reaches the browser.</summary>
    public string ApiKey { get; set; } = "";

    /// <summary>
    /// Hub URL handed to the browser. Defaults to <see cref="ServiceBaseUrl"/>
    /// plus <c>/hubs/cobrowse</c>; override when browsers reach the service under
    /// a different public name than the server does.
    /// </summary>
    public string? PublicHubUrl { get; set; }

    /// <summary>Ask for view + control by default. Users can revoke control from the banner.</summary>
    public bool AllowControl { get; set; } = true;

    /// <summary>Call the service with this timeout so a dead service cannot hang a circuit.</summary>
    public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromSeconds(8);

    /// <summary>Mask <c>input[type=password]</c> in the stream. On by default.</summary>
    public bool MaskPasswords { get; set; } = true;

    /// <summary>Label of the support button rendered into tenant pages.</summary>
    public string ButtonLabel { get; set; } = "Request remote support";

    /// <summary>Value reported on the wire so the service can show which plugin build a tenant runs.</summary>
    public string ProductName { get; set; } = "App.Cobrowse";

    /// <summary>The plugin's informational version, read from the assembly.</summary>
    public static string PluginVersion { get; } =
        typeof(CobrowseOptions).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion.Split('+')[0]
        ?? "0.0.0";

    internal string ClientHeader =>
        string.Create(System.Globalization.CultureInfo.InvariantCulture,
            $"{ProductName}/{PluginVersion}; protocol={Contracts.CobrowseProtocol.Http}");

    internal string ResolveHubUrl()
    {
        if (!string.IsNullOrWhiteSpace(PublicHubUrl))
            return PublicHubUrl.TrimEnd('/');

        if (!Uri.TryCreate(ServiceBaseUrl, UriKind.Absolute, out var baseUri))
            return Contracts.CobrowseProtocol.HubPath;

        return baseUri.ToString().TrimEnd('/') + Contracts.CobrowseProtocol.HubPath;
    }

    internal void Validate()
    {
        if (!Uri.TryCreate(ServiceBaseUrl, UriKind.Absolute, out _))
            throw new InvalidOperationException(
                "Cobrowse:ServiceBaseUrl must be an absolute URL, e.g. http://cobrowse.internal:5199");

        if (string.IsNullOrWhiteSpace(TenantId))
            throw new InvalidOperationException("Cobrowse:TenantId is required.");

        if (string.IsNullOrWhiteSpace(ApiKey))
            throw new InvalidOperationException("Cobrowse:ApiKey is required.");

        if (RequestTimeout <= TimeSpan.Zero)
            RequestTimeout = TimeSpan.FromSeconds(8);
    }
}
