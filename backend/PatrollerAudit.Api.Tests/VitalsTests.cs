using PatrollerAudit.Api;

namespace PatrollerAudit.Api.Tests;

public sealed class VitalsTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-12T19:00:00Z");

    [Theory]
    [InlineData(null, null, null, false)]
    [InlineData(0, null, null, false)]
    [InlineData(null, -1, null, false)]
    [InlineData(null, null, 101, false)]
    [InlineData(null, null, 0, true)]
    [InlineData(null, null, 100, true)]
    [InlineData(70, null, null, true)]
    [InlineData(null, 12, null, true)]
    public void ValidatesPartialMeasurements(int? heart, int? respiration, int? spo2, bool valid)
    {
        var value = new VitalValues(Now.AddYears(-1), heart, respiration, spo2, null, null);
        Assert.Equal(valid, Vitals.Validate(value, Now) is null);
    }

    [Fact]
    public void RejectsFutureMissingTimeAndOversizedFields()
    {
        var value = new VitalValues(Now, 80, null, null, null, null);
        Assert.Null(Vitals.Validate(value, Now));
        Assert.NotNull(Vitals.Validate(value with { MeasuredAt = Now.AddTicks(1) }, Now));
        Assert.NotNull(Vitals.Validate(value with { MeasuredAt = default }, Now));
        Assert.NotNull(Vitals.Validate(value with { ReportingPatroller = new string('x', 101) }, Now));
        Assert.NotNull(Vitals.Validate(value with { Note = new string('x', 2001) }, Now));
    }
}
