using System.Net;
using System.Security.Claims;
using System.Text;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using PatrollerAudit.Api.Infrastructure;

namespace PatrollerAudit.Api;

[JsonObject(NamingStrategyType = typeof(CamelCaseNamingStrategy))]
public sealed record VitalValues(DateTimeOffset MeasuredAt, int? HeartRate, int? RespiratoryRate,
    int? Spo2, string? ReportingPatroller, string? Note);

public sealed record SaveVital(Guid OperationId, VitalValues Value);

[JsonObject(NamingStrategyType = typeof(CamelCaseNamingStrategy))]
public sealed record VitalReport(string Id, string IncidentKey, string IncidentId, string ResortId,
    VitalValues Value, string CreatedBy, DateTimeOffset CreatedAt, long Revision,
    string UpdatedBy, DateTimeOffset UpdatedAt, string Type = "report", int SchemaVersion = 1);

[JsonObject(NamingStrategyType = typeof(CamelCaseNamingStrategy))]
public sealed record VitalRevision(string Id, string IncidentKey, string ReportId, string OperationId,
    bool IsCreation, VitalValues? Before, VitalValues After, string Editor, DateTimeOffset EditedAt,
    long Revision, string Type = "revision", int SchemaVersion = 1);

public static class Vitals
{
    private sealed record PageCursor(string Scope, string MeasuredAt, string CreatedAt, string Id, long Revision);

    public static string? Validate(VitalValues? value, DateTimeOffset now)
    {
        if (value is null) return "A vital report is required.";
        if (value.HeartRate is null && value.RespiratoryRate is null && value.Spo2 is null)
            return "Enter at least one vital.";
        if (value.HeartRate is <= 0 || value.RespiratoryRate is <= 0 || value.Spo2 is < 0 or > 100)
            return "Rates must be positive whole numbers; SpO2 must be a whole number from 0 to 100.";
        if (value.MeasuredAt == default || value.MeasuredAt > now)
            return "Measurement time is required and cannot be in the future.";
        if (value.ReportingPatroller?.Length > 100 || value.Note?.Length > 2000)
            return "Reporting patroller is limited to 100 characters and notes to 2,000.";
        return null;
    }

    public static void MapVitals(this WebApplication app)
    {
        var group = app.MapGroup("/api/incidents/{incidentId:guid}/vitals")
            .RequireAuthorization("SummitWestDispatcher");
        group.AddEndpointFilter(async (context, next) =>
        {
            var storage = context.HttpContext.RequestServices.GetRequiredService<CosmosReadiness>();
            var cancellation = context.HttpContext.RequestAborted;
            if ((await storage.CheckHealthAsync(new HealthCheckContext(), cancellation)).Status != HealthStatus.Healthy)
                return Results.Problem(statusCode: 503, title: "Vital storage is unavailable.");
            var incidentId = Guid.Parse(context.HttpContext.Request.RouteValues["incidentId"]!.ToString()!).ToString();
            try
            {
                await storage.Incidents.ReadItemAsync<Incident>(incidentId,
                    new PartitionKey(Incidents.ResortId), cancellationToken: cancellation);
            }
            catch (CosmosException exception) when (exception.StatusCode == HttpStatusCode.NotFound)
            {
                return Results.NotFound();
            }
            return await next(context);
        });

        group.MapGet("/", (Guid incidentId, string? cursor, CosmosReadiness storage, CancellationToken cancellation) =>
            ReadReports(storage.Vitals, Key(incidentId), cursor, cancellation));
        group.MapGet("/{reportId:guid}/history", (Guid incidentId, Guid reportId, string? cursor,
            CosmosReadiness storage, CancellationToken cancellation) =>
            ReadHistory(storage.Vitals, Key(incidentId), reportId.ToString(), cursor, cancellation));
        group.MapPost("/{reportId:guid}", (Guid incidentId, Guid reportId, SaveVital input, ClaimsPrincipal user,
            CosmosReadiness storage, TimeProvider clock, CancellationToken cancellation) =>
            Save(incidentId, reportId, input, true, user, storage.Vitals, clock, cancellation));
        group.MapPut("/{reportId:guid}", (Guid incidentId, Guid reportId, SaveVital input, ClaimsPrincipal user,
            CosmosReadiness storage, TimeProvider clock, CancellationToken cancellation) =>
            Save(incidentId, reportId, input, false, user, storage.Vitals, clock, cancellation));
    }

    private static string Key(Guid incidentId) => $"{Incidents.ResortId}:{incidentId}";

    private static bool TryCursor(string? text, string scope, out PageCursor? cursor)
    {
        cursor = null;
        if (text is null) return true;
        if (text.Length > 2048) return false;
        try
        {
            cursor = JsonConvert.DeserializeObject<PageCursor>(Encoding.UTF8.GetString(Convert.FromBase64String(text)));
            return cursor is not null && cursor.Scope == scope && cursor.Id is not null
                && cursor.MeasuredAt is not null && cursor.CreatedAt is not null && cursor.Revision >= 0;
        }
        catch (Exception exception) when (exception is FormatException or JsonException) { return false; }
    }

    private static string EncodeCursor(PageCursor cursor) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(cursor)));

    private static string StoredTime(DateTimeOffset time) => JsonConvert.SerializeObject(time).Trim('"');

    private static Task<IResult> ReadReports(Container container, string key, string? cursor, CancellationToken cancellation)
    {
        if (!TryCursor(cursor, key, out var after))
            return Task.FromResult<IResult>(Results.BadRequest(new { message = "Invalid vital history cursor." }));
        var filter = after is null ? "" : """
             AND (c["value"]["measuredAt"] < @time
               OR (c["value"]["measuredAt"] = @time AND c.createdAt < @created)
               OR (c["value"]["measuredAt"] = @time AND c.createdAt = @created AND c.id > @id))
            """;
        var query = new QueryDefinition("SELECT TOP 101 * FROM c WHERE c.type = 'report'" + filter +
            " ORDER BY c[\"value\"][\"measuredAt\"] DESC, c.createdAt DESC, c.id ASC");
        if (after is not null)
            query.WithParameter("@time", after.MeasuredAt).WithParameter("@created", after.CreatedAt).WithParameter("@id", after.Id);
        return ReadPage<VitalReport>(container, key, query, report => EncodeCursor(new PageCursor(key,
            StoredTime(report.Value.MeasuredAt), StoredTime(report.CreatedAt), report.Id, 0)), cancellation);
    }

    private static Task<IResult> ReadHistory(Container container, string key, string reportId, string? cursor,
        CancellationToken cancellation)
    {
        var scope = $"{key}:{reportId}";
        if (!TryCursor(cursor, scope, out var after))
            return Task.FromResult<IResult>(Results.BadRequest(new { message = "Invalid vital history cursor." }));
        var query = new QueryDefinition("""
            SELECT TOP 101 * FROM c WHERE c.type = 'revision' AND c.reportId = @report
              AND c.revision > @revision ORDER BY c.revision ASC
            """).WithParameter("@report", reportId).WithParameter("@revision", after?.Revision ?? 0);
        return ReadPage<VitalRevision>(container, key, query, revision => EncodeCursor(new PageCursor(scope,
            "", "", revision.Id, revision.Revision)), cancellation);
    }

    private static async Task<IResult> ReadPage<T>(Container container, string key, QueryDefinition query,
        Func<T, string> cursorFor, CancellationToken cancellation)
    {
        using var iterator = container.GetItemQueryIterator<T>(query,
            requestOptions: new QueryRequestOptions { PartitionKey = new PartitionKey(key), MaxItemCount = 101 });
        var items = new List<T>();
        while (iterator.HasMoreResults)
            items.AddRange(await iterator.ReadNextAsync(cancellation));
        // MaxItemCount is only a service hint. TOP bounds the query; the extra record indicates another page.
        return Results.Ok(new { items = items.Take(100), cursor = items.Count > 100 ? cursorFor(items[99]) : null });
    }

    private static async Task<ItemResponse<T>?> Read<T>(Container container, string id, PartitionKey key,
        CancellationToken cancellation)
    {
        try { return await container.ReadItemAsync<T>(id, key, cancellationToken: cancellation); }
        catch (CosmosException exception) when (exception.StatusCode == HttpStatusCode.NotFound) { return null; }
    }

    private static async Task<IResult> Save(Guid incidentId, Guid reportId, SaveVital input, bool creating,
        ClaimsPrincipal user, Container container, TimeProvider clock, CancellationToken cancellation)
    {
        var error = Validate(input.Value, clock.GetUtcNow());
        if (reportId == Guid.Empty || input.OperationId == Guid.Empty || error is not null)
            return Results.BadRequest(new { message = error ?? "Nonempty report and operation UUIDs are required." });
        var value = input.Value with { MeasuredAt = input.Value.MeasuredAt.ToUniversalTime() };
        var key = Key(incidentId);
        var partition = new PartitionKey(key);
        var id = reportId.ToString();
        var receiptId = $"{id}:{input.OperationId}";
        var editor = user.FindFirstValue("sub")!;

        for (var attempt = 0; attempt < 8; attempt++)
        {
            var previous = await Read<VitalReport>(container, id, partition, cancellation);
            var receipt = await Read<VitalRevision>(container, receiptId, partition, cancellation);
            if (receipt is not null)
            {
                if (receipt.Resource.Editor != editor || receipt.Resource.IsCreation != creating ||
                    receipt.Resource.After != value)
                    return Results.Conflict(new { message = "This operation ID is already in use for different input." });
                var current = await Read<VitalReport>(container, id, partition, cancellation);
                return Results.Ok(new { report = current!.Resource, acceptedRevision = receipt.Resource.Revision });
            }
            if (creating && previous is not null)
                return Results.Conflict(new { message = "This report ID is already in use." });
            if (!creating && previous is null) return Results.NotFound();

            var now = clock.GetUtcNow();
            var revision = (previous?.Resource.Revision ?? 0) + 1;
            var report = new VitalReport(id, key, incidentId.ToString(), Incidents.ResortId, value,
                previous?.Resource.CreatedBy ?? editor, previous?.Resource.CreatedAt ?? now, revision, editor, now);
            var audit = new VitalRevision(receiptId, key, id, input.OperationId.ToString(), creating,
                previous?.Resource.Value, value, editor, now, revision);
            var batch = container.CreateTransactionalBatch(partition);
            if (creating) batch.CreateItem(report);
            else batch.ReplaceItem(id, report, new TransactionalBatchItemRequestOptions { IfMatchEtag = previous!.ETag });
            batch.CreateItem(audit);
            using var result = await batch.ExecuteAsync(cancellation);
            if (result.IsSuccessStatusCode)
                return Results.Json(new { report, acceptedRevision = revision }, statusCode: creating ? 201 : 200);
            // Re-read both receipt and current state: serialize approved overwrites without losing audit entries.
            if (result.Any(operation => operation.StatusCode is HttpStatusCode.Conflict or HttpStatusCode.PreconditionFailed))
                continue;
            return Results.Problem(statusCode: 503, title: "Save was not confirmed. Retry the same operation.");
        }
        return Results.Problem(statusCode: 503, title: "The report is busy. Retry the same operation.");
    }
}
