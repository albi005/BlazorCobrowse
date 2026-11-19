using CobrowseService.Auth;
using CobrowseService.Contracts;
using CobrowseService.Sessions;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;

namespace CobrowseService.Http;

/// <summary>
/// The tenant-facing API. Deliberately small: a tenant app only ever creates a
/// request and polls its status. Everything live goes over the hub, whose join
/// tickets are minted by this service and handed to browsers through the tenant
/// app.
/// </summary>
public static class SupportRequestEndpoints
{
    public static void MapSupportRequestEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup(CobrowseProtocol.ApiPrefix + "/support-requests");

        group.MapPost("/", CreateAsync);
        group.MapGet("/{id}", GetAsync);
        group.MapPost("/{id}/cancel", CancelAsync);
    }

    /// <summary>
    /// Agent-facing API for clients that are not the Blazor console. The
    /// identity comes from <see cref="IAgentIdentityProvider"/>; an LDAP/OIDC
    /// front end replaces that implementation without changing these routes.
    /// </summary>
    public static void MapAgentEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup(CobrowseProtocol.ApiPrefix + "/agent");

        group.MapGet("/queue", ListQueue);
        group.MapPost("/requests/{id}/accept", AcceptAsync);
        group.MapPost("/requests/{id}/ticket", IssueTicket);
    }

    private static IResult ListQueue(
        HttpContext context,
        IAgentIdentityProvider agents,
        SupportRequestService requests)
    {
        var agent = agents.GetCurrent(context);
        return Results.Ok(new
        {
            pending = requests.ListPending().Select(r => r.ToStatus()),
            active = requests.ListActiveForAgent(agent.Id).Select(r => r.ToStatus())
        });
    }

    private static async Task<IResult> AcceptAsync(
        HttpContext context,
        string id,
        IAgentIdentityProvider agents,
        SupportRequestService requests,
        JoinTicketService tickets)
    {
        var agent = agents.GetCurrent(context);
        var outcome = await requests.AcceptAsync(id, agent);

        if (!outcome.Success)
        {
            return Problem(
                outcome.ErrorCode == "not_found" ? StatusCodes.Status404NotFound : StatusCodes.Status409Conflict,
                outcome.ErrorCode ?? "accept_failed",
                outcome.ErrorMessage ?? "The request could not be accepted.");
        }

        var ticket = tickets.Issue(id, TicketKind.Agent, agent.Id, TimeSpan.FromMinutes(10));
        return Results.Ok(new { request = outcome.Request!.ToStatus(), ticket });
    }

    private static IResult IssueTicket(
        HttpContext context,
        string id,
        IAgentIdentityProvider agents,
        SupportRequestService requests,
        JoinTicketService tickets)
    {
        var agent = agents.GetCurrent(context);
        var snapshot = requests.Get(id);

        if (snapshot is null)
            return Problem(StatusCodes.Status404NotFound, "not_found", "No such support request.");

        if (snapshot.State != SupportRequestState.Active || snapshot.Agent?.Id != agent.Id)
            return Problem(StatusCodes.Status409Conflict, "not_assigned", "This session is not assigned to you.");

        var ticket = tickets.Issue(id, TicketKind.Agent, agent.Id, TimeSpan.FromMinutes(10));
        return Results.Ok(new { ticket });
    }

    private static async Task<IResult> CreateAsync(
        HttpRequest http,
        HttpResponse response,
        CreateSupportRequestRequest body,
        ITenantDirectory tenants,
        SupportRequestService requests,
        IOptions<CobrowseOptions> options,
        CancellationToken cancellationToken)
    {
        var tenant = tenants.Authenticate(http);
        if (tenant is null)
            return Problem(StatusCodes.Status401Unauthorized, "tenant_unauthorized", "Unknown or missing tenant credentials.");

        var selected = http.GetCobrowseProtocol() ?? options.Value.MaxHttpProtocol;
        if (selected < options.Value.MinHttpProtocol || selected > options.Value.MaxHttpProtocol)
        {
            return Problem(
                StatusCodes.Status426UpgradeRequired,
                "protocol_unsupported",
                $"This service speaks protocol {options.Value.MinHttpProtocol}-{options.Value.MaxHttpProtocol}.",
                new Dictionary<string, object?>
                {
                    ["minSupported"] = options.Value.MinHttpProtocol,
                    ["maxSupported"] = options.Value.MaxHttpProtocol,
                });
        }

        var errors = Validate(body);
        if (errors.Count > 0)
        {
            return Results.ValidationProblem(
                errors,
                detail: "The support request is invalid.",
                statusCode: StatusCodes.Status400BadRequest,
                extensions: new Dictionary<string, object?> { ["code"] = "validation" });
        }

        var hubUrl = ResolveHubUrl(options.Value, http);
        var created = await requests.CreateAsync(body, tenant, hubUrl);

        response.Headers[CobrowseProtocol.ProtocolHeader] = options.Value.MaxHttpProtocol.ToString();
        return Results.Created($"{CobrowseProtocol.ApiPrefix}/support-requests/{created.RequestId}", created);
    }

    private static IResult GetAsync(
        HttpRequest http,
        string id,
        ITenantDirectory tenants,
        SupportRequestService requests)
    {
        var tenant = tenants.Authenticate(http);
        if (tenant is null)
            return Problem(StatusCodes.Status401Unauthorized, "tenant_unauthorized", "Unknown or missing tenant credentials.");

        var snapshot = requests.GetForTenant(id, tenant.Id);
        return snapshot is null
            ? Problem(StatusCodes.Status404NotFound, "not_found", "No such support request.")
            : Results.Ok(snapshot.ToStatus());
    }

    private static async Task<IResult> CancelAsync(
        HttpRequest http,
        string id,
        ITenantDirectory tenants,
        SupportRequestService requests)
    {
        var tenant = tenants.Authenticate(http);
        if (tenant is null)
            return Problem(StatusCodes.Status401Unauthorized, "tenant_unauthorized", "Unknown or missing tenant credentials.");

        var snapshot = requests.GetForTenant(id, tenant.Id);
        if (snapshot is null)
            return Problem(StatusCodes.Status404NotFound, "not_found", "No such support request.");

        if (snapshot.IsTerminal)
            return Problem(StatusCodes.Status409Conflict, "not_cancellable", "The support request has already finished.");

        var updated = await requests.EndAsync(
            id,
            "tenant-cancelled",
            "The tenant application cancelled the request.",
            SupportRequestState.Cancelled);

        return updated is null
            ? Problem(StatusCodes.Status404NotFound, "not_found", "No such support request.")
            : Results.Ok(updated.ToStatus());
    }

    private static Dictionary<string, string[]> Validate(CreateSupportRequestRequest request)
    {
        var errors = new Dictionary<string, string[]>(StringComparer.Ordinal);

        void Add(string key, string message)
        {
            errors[key] = errors.TryGetValue(key, out var existing)
                ? [.. existing, message]
                : [message];
        }

        if (request.User is null)
        {
            Add("user", "A user is required.");
        }
        else
        {
            if (string.IsNullOrWhiteSpace(request.User.Id))
                Add("user.id", "A stable user id is required.");
            else if (request.User.Id.Length > 200)
                Add("user.id", "The user id is too long.");

            if (string.IsNullOrWhiteSpace(request.User.DisplayName))
                Add("user.displayName", "A display name is required.");
            else if (request.User.DisplayName.Length > 200)
                Add("user.displayName", "The display name is too long.");

            if (request.User.Email is { Length: > 320 })
                Add("user.email", "The email address is too long.");
        }

        if (request.Page is not null)
        {
            if (request.Page.Url is { Length: > 2048 })
                Add("page.url", "The page URL is too long.");

            if (request.Page.Title is { Length: > 300 })
                Add("page.title", "The page title is too long.");
        }

        if (request.Note is { Length: > 1000 })
            Add("note", "The note is too long.");

        if (request.Metadata is { Count: > 20 })
            Add("metadata", "Too many metadata entries.");

        if (request.Metadata is not null)
        {
            foreach (var (key, value) in request.Metadata)
            {
                if (string.IsNullOrWhiteSpace(key) || key.Length > 64)
                    Add("metadata", "Metadata keys must be 1-64 characters.");

                if (value is { Length: > 512 })
                    Add("metadata", "Metadata values must be at most 512 characters.");
            }
        }

        return errors;
    }

    private static string ResolveHubUrl(CobrowseOptions options, HttpRequest http)
    {
        if (!string.IsNullOrWhiteSpace(options.PublicHubUrl))
            return options.PublicHubUrl.TrimEnd('/');

        var baseUrl = options.PublicBaseUrl?.TrimEnd('/') ?? $"{http.Scheme}://{http.Host}{http.PathBase}";
        return $"{baseUrl}{CobrowseProtocol.HubPath}";
    }

    private static IResult Problem(
        int statusCode,
        string code,
        string detail,
        IDictionary<string, object?>? extensions = null)
    {
        var all = new Dictionary<string, object?>(extensions ?? new Dictionary<string, object?>())
        {
            ["code"] = code,
        };

        return Results.Problem(
            detail: detail,
            statusCode: statusCode,
            title: "Cobrowse request failed",
            extensions: all);
    }
}

public static class HttpProtocolExtensions
{
    public static int? GetCobrowseProtocol(this HttpRequest request)
    {
        if (!request.Headers.TryGetValue(CobrowseProtocol.ProtocolHeader, out var raw))
            return null;

        return int.TryParse(raw.ToString(), out var protocol) && protocol > 0 ? protocol : null;
    }
}
