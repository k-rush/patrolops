using Azure.Monitor.OpenTelemetry.AspNetCore;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using PatrollerAudit.Api;
using PatrollerAudit.Api.Infrastructure;

var builder = WebApplication.CreateBuilder(args);
var settings = new RuntimeSettings(builder.Configuration, builder.Environment);
builder.Services.AddSingleton(settings);
builder.Services.AddProblemDetails();
builder.Services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = false);
builder.Services.AddFirebaseAuthentication(settings);
builder.Services.AddSingleton<CosmosReadiness>();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddHealthChecks().AddCheck<CosmosReadiness>("cosmos", tags: ["ready"]);
if (!string.IsNullOrWhiteSpace(builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"]))
    builder.Services.AddOpenTelemetry().UseAzureMonitor();

var app = builder.Build();
app.UseExceptionHandler();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseAuthentication();
app.UseAuthorization();

app.MapHealthChecks("/health", new HealthCheckOptions { Predicate = _ => false }).AllowAnonymous();
app.MapHealthChecks("/api/health", new HealthCheckOptions { Predicate = check => check.Tags.Contains("ready") }).AllowAnonymous();
app.MapGet("/api/config", (IConfiguration configuration) => Results.Ok(new
{
    projectId = settings.ProjectId,
    apiKey = settings.EmulatorEnabled ? "local-emulator" : configuration["Auth:ApiKey"],
    authDomain = configuration["Auth:Domain"] ?? $"{settings.ProjectId}.firebaseapp.com",
    emulatorUrl = settings.EmulatorEnabled ? configuration["Auth:EmulatorPublicUrl"] : null
})).AllowAnonymous();
app.MapIncidents();
app.MapVitals();
app.MapGet("/api/{**path}", () => Results.NotFound()).AllowAnonymous();
app.MapFallbackToFile("index.html").AllowAnonymous();
app.Run();

public partial class Program;
