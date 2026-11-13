using System.Net.Security;
using System.Collections.ObjectModel;
using System.Security.Cryptography.X509Certificates;
using Azure.Identity;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace PatrollerAudit.Api.Infrastructure;

public sealed class CosmosReadiness(RuntimeSettings settings) : IHealthCheck, IDisposable
{
    private CosmosClient? client;
    private X509Certificate2? emulatorCertificate;
    private readonly SemaphoreSlim initialization = new(1, 1);

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        if (!settings.StorageConfigured)
            return HealthCheckResult.Unhealthy("Cosmos is not configured.");

        try
        {
            await initialization.WaitAsync(cancellationToken);
            try
            {
                client ??= CreateClient();
            }
            finally
            {
                initialization.Release();
            }

            // Cloud containers and permissions are provisioned before application rollout.
            if (settings.EmulatorEnabled)
            {
                var database = await client.CreateDatabaseIfNotExistsAsync(settings.DatabaseName, cancellationToken: cancellationToken);
                await database.Database.CreateContainerIfNotExistsAsync("incidents", "/resortId", cancellationToken: cancellationToken);
                var vitals = new ContainerProperties("vitals", "/incidentKey");
                vitals.IndexingPolicy.CompositeIndexes.Add(new Collection<CompositePath>
                {
                    new() { Path = "/value/measuredAt", Order = CompositePathSortOrder.Descending },
                    new() { Path = "/createdAt", Order = CompositePathSortOrder.Descending },
                    new() { Path = "/id", Order = CompositePathSortOrder.Ascending }
                });
                await database.Database.CreateContainerIfNotExistsAsync(vitals, cancellationToken: cancellationToken);
            }
            else
            {
                await client.GetContainer(settings.DatabaseName, "incidents").ReadContainerAsync(cancellationToken: cancellationToken);
                await client.GetContainer(settings.DatabaseName, "vitals").ReadContainerAsync(cancellationToken: cancellationToken);
            }
            return HealthCheckResult.Healthy();
        }
        catch (Exception exception) when (exception is CosmosException or HttpRequestException or Azure.Identity.AuthenticationFailedException)
        {
            return HealthCheckResult.Unhealthy("Cosmos is unavailable.");
        }
    }

    public Container Incidents => client?.GetContainer(settings.DatabaseName, "incidents")
        ?? throw new InvalidOperationException("Storage is not ready.");

    public Container Vitals => client?.GetContainer(settings.DatabaseName, "vitals")
        ?? throw new InvalidOperationException("Storage is not ready.");

    private CosmosClient CreateClient()
    {
        var options = new CosmosClientOptions
        {
            ConnectionMode = ConnectionMode.Gateway,
            RequestTimeout = TimeSpan.FromSeconds(5),
            MaxRetryAttemptsOnRateLimitedRequests = 0
        };
        if (!settings.EmulatorEnabled)
            return new CosmosClient(settings.CosmosEndpoint, new DefaultAzureCredential(), options);

        emulatorCertificate = X509Certificate2.CreateFromPem(File.ReadAllText(settings.CertificatePath));
        options.ConsistencyLevel = ConsistencyLevel.Eventual;
        options.HttpClientFactory = () => new HttpClient(new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = (_, presented, _, errors) =>
                presented is not null && (errors & SslPolicyErrors.RemoteCertificateNotAvailable) == 0 &&
                presented.RawData.AsSpan().SequenceEqual(emulatorCertificate.RawData)
        }, disposeHandler: true);
        return new CosmosClient(settings.ConnectionString, options);
    }

    public void Dispose()
    {
        client?.Dispose();
        emulatorCertificate?.Dispose();
        initialization.Dispose();
    }
}
