using CobrowseService;
using CobrowseService.Auth;
using CobrowseService.Components;
using CobrowseService.Contracts;
using CobrowseService.Http;
using CobrowseService.Realtime;
using CobrowseService.Sessions;

var builder = WebApplication.CreateBuilder(args);

// ---------------------------------------------------------------- options

builder.Services.Configure<CobrowseOptions>(builder.Configuration.GetSection("Cobrowse"));
builder.Services.Configure<TenantsOptions>(builder.Configuration.GetSection("Tenants"));
builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection("Agent"));

var maxHubMessageBytes = builder.Configuration.GetValue<long?>("Cobrowse:MaxHubMessageBytes")
                         ?? 10 * 1024 * 1024;

// ---------------------------------------------------------------- services

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.AddHttpContextAccessor();

builder.Services.AddSignalR(options =>
{
    // A full rrweb snapshot can be several megabytes.
    options.MaximumReceiveMessageSize = maxHubMessageBytes;
    options.EnableDetailedErrors = builder.Environment.IsDevelopment();
});

var allowedOrigins = builder.Configuration.GetSection("Cobrowse:AllowedOrigins").Get<string[]>() ?? [];
builder.Services.AddCors(options => options.AddPolicy("cobrowse", policy =>
{
    if (allowedOrigins.Length == 0)
    {
        // Development default: any tenant page may open the hub. Configure
        // Cobrowse:AllowedOrigins in production.
        policy.SetIsOriginAllowed(_ => true);
    }
    else
    {
        policy.WithOrigins(allowedOrigins);
    }

    policy.AllowAnyHeader().AllowAnyMethod().AllowCredentials();
}));

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<ISupportRequestStore, InMemorySupportRequestStore>();
builder.Services.AddSingleton<JoinTicketService>();
builder.Services.AddSingleton<SessionRegistry>();
builder.Services.AddSingleton<RequestNotifier>();
builder.Services.AddSingleton<ISupportEvents, SupportEvents>();
builder.Services.AddSingleton<SupportRequestService>();
builder.Services.AddSingleton<ITenantDirectory, TenantDirectory>();
builder.Services.AddSingleton<IAgentIdentityProvider, AgentIdentityProvider>();
builder.Services.AddHostedService<SupportRequestSweeper>();

// ---------------------------------------------------------------- pipeline

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
}

app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
app.UseCors("cobrowse");
app.UseAntiforgery();

app.MapStaticAssets();
app.MapSupportRequestEndpoints();
app.MapAgentEndpoints();
app.MapHub<CobrowseHub>(CobrowseProtocol.HubPath);
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
