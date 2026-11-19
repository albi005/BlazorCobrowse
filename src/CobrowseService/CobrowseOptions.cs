namespace CobrowseService;

public sealed class CobrowseOptions
{
    /// <summary>
    /// Origin browsers use to reach the hub, e.g. <c>https://support.example.com</c>.
    /// When empty, the origin of the inbound tenant request is used, which is
    /// fine for local development and wrong behind a reverse proxy.
    /// </summary>
    public string? PublicBaseUrl { get; set; }

    /// <summary>
    /// Full hub URL handed to tenant browsers, e.g.
    /// <c>https://support.example.com/hubs/cobrowse</c>. Overrides
    /// <see cref="PublicBaseUrl"/> when set.
    /// </summary>
    public string? PublicHubUrl { get; set; }

    /// <summary>How long a request may wait in the queue before it expires.</summary>
    public TimeSpan RequestLifetime { get; set; } = TimeSpan.FromMinutes(10);

    /// <summary>Hard ceiling for an accepted session.</summary>
    public TimeSpan SessionLifetime { get; set; } = TimeSpan.FromHours(8);

    /// <summary>Customer tab may reconnect within this window without ending the session.</summary>
    public TimeSpan CustomerDisconnectGrace { get; set; } = TimeSpan.FromSeconds(45);

    /// <summary>How long ended requests stay queryable for status/audit.</summary>
    public TimeSpan RetentionAfterEnd { get; set; } = TimeSpan.FromHours(1);

    public int MaxBacklogEvents { get; set; } = 20_000;

    public long MaxBacklogBytes { get; set; } = 8 * 1024 * 1024;

    /// <summary>SignalR inbound limit; a full rrweb snapshot can be several MB.</summary>
    public int MaxHubMessageBytes { get; set; } = 10 * 1024 * 1024;

    /// <summary>Origins allowed to open the hub from a tenant page. Empty = any (dev).</summary>
    public string[] AllowedOrigins { get; set; } = [];

    public int MinHttpProtocol { get; set; } = Contracts.CobrowseProtocol.Http;
    public int MaxHttpProtocol { get; set; } = Contracts.CobrowseProtocol.Http;
    public int MinHubProtocol { get; set; } = Contracts.CobrowseProtocol.Hub;
    public int MaxHubProtocol { get; set; } = Contracts.CobrowseProtocol.Hub;
}
