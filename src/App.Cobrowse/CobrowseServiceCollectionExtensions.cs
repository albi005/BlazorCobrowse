using Cobrowse.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Cobrowse;

public static class CobrowseServiceCollectionExtensions
{
    /// <summary>
    /// Registers the plugin: a typed HTTP client to the cobrowse service, the
    /// per-circuit session state machine, and the browser-side static assets
    /// (served from <c>_content/App.Cobrowse/</c>).
    /// </summary>
    public static IServiceCollection AddCobrowse(this IServiceCollection services, IConfigurationSection section)
    {
        services.Configure<CobrowseOptions>(section);
        return services.AddCobrowseCore();
    }

    public static IServiceCollection AddCobrowse(this IServiceCollection services, Action<CobrowseOptions> configure)
    {
        services.Configure(configure);
        return services.AddCobrowseCore();
    }

    private static IServiceCollection AddCobrowseCore(this IServiceCollection services)
    {
        services.AddSingleton<IValidateOptions<CobrowseOptions>, ValidateCobrowseOptions>();

        services.AddHttpClient<ICobrowseRequests, CobrowseRequestClient>((sp, http) =>
        {
            var options = sp.GetRequiredService<IOptions<CobrowseOptions>>().Value;
            options.Validate();

            http.BaseAddress = new Uri(options.ServiceBaseUrl.TrimEnd('/') + "/");
            http.Timeout = options.RequestTimeout;
            http.DefaultRequestHeaders.TryAddWithoutValidation(CobrowseProtocol.TenantHeader, options.TenantId);
            http.DefaultRequestHeaders.TryAddWithoutValidation(CobrowseProtocol.KeyHeader, options.ApiKey);
            http.DefaultRequestHeaders.TryAddWithoutValidation(CobrowseProtocol.ClientHeader, options.ClientHeader);
            http.DefaultRequestHeaders.TryAddWithoutValidation(
                CobrowseProtocol.ProtocolHeader,
                CobrowseProtocol.Http.ToString(System.Globalization.CultureInfo.InvariantCulture));
        });

        // One session per Blazor circuit: two buttons in the same tab must not
        // create two support requests.
        services.AddScoped<CobrowseSession>();
        services.TryAddUserProvider();

        return services;
    }

    private static void TryAddUserProvider(this IServiceCollection services)
    {
        if (services.All(d => d.ServiceType != typeof(ICobrowseUserProvider)))
            services.AddSingleton<ICobrowseUserProvider, ClaimsCobrowseUserProvider>();
    }

    private sealed class ValidateCobrowseOptions : IValidateOptions<CobrowseOptions>
    {
        public ValidateOptionsResult Validate(string? name, CobrowseOptions options)
        {
            try
            {
                options.Validate();
                return ValidateOptionsResult.Success;
            }
            catch (InvalidOperationException ex)
            {
                return ValidateOptionsResult.Fail(ex.Message);
            }
        }
    }
}
