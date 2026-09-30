using System;
using System.Linq;

namespace Sample.Legacy
{
    /// <summary>Block-scoped namespace, older style.</summary>
    public abstract class Shape
    {
        protected Shape(string name)
        {
            Name = name;
        }

        public string Name { get; }

        public abstract double Area();

        public override string ToString()
        {
            return $"{Name}: {Area():F2}";
        }

        public class Builder
        {
            public Shape Build(string kind)
            {
                switch (kind)
                {
                    case "circle":
                        return new Circle(1.0);
                    default:
                        throw new ArgumentException(kind);
                }
            }
        }
    }

    public sealed class Circle : Shape
    {
        private readonly double _r;

        public Circle(double r) : base("circle")
        {
            _r = r;
        }

        public override double Area() => Math.PI * _r * _r;
    }

    public delegate void Notify(string message);

    internal static class Extensions
    {
        public static IEnumerable<T> Twice<T>(this IEnumerable<T> src)
        {
            return src.Concat(src);
        }
    }
}
