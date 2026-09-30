using System;
using System.Collections.Generic;
using System.Text;
using A = Some.Alias.Namespace;

namespace Sample.Layout;

/// <summary>
/// A composer that lays blocks out on a slide. Synthetic fixture: authored for the
/// scanner tests, shaped like real-world renderer code.
/// </summary>
[Serializable]
public static class BodyComposer
{
    private const int Padding = 12;

    public static long Compose(IReadOnlyList<Block> blocks, long width)
    {
        long total = 0;
        foreach (var block in blocks)
        {
            // A local function: at member depth in a file-scoped namespace, but NOT a member.
            long Height(Block b)
            {
                return b.Lines * 240 + Padding;
            }

            total += Height(block);
        }
        return total;
    }

    /// <summary>The label, with braces { } that are just text.</summary>
    public static string Describe(Block block) => $"block {{{block.Kind}}} at {block.Lines}";

    public static string Verbatim() => @"a ""quoted"" { brace
spans lines }";

    public static string Raw() => """
        {
          "json": "looks like a scope }"
        }
        """;

    private static char Open() => '{';

#if DEBUG
    public static void DebugOnly() { }
#endif

    public sealed record Block(string Kind, int Lines);

    public enum Mode
    {
        Fit,
        Fill,
    }

    public static int Count { get; set; }

    public static event EventHandler? Changed;

    public static T Pick<T>(IEnumerable<T> items, Func<T, bool> where)
        where T : class
    {
        foreach (var item in items)
        {
            if (where(item)) { return item; }
        }
        return default!;
    }
}

public interface ILayout
{
    long Measure(long width);
}

public struct Point
{
    public int X;
    public int Y;

    public Point(int x, int y) { X = x; Y = y; }
}
