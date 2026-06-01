import argparse
from pathlib import Path

from PIL import Image


DEFAULT_SIZES = (16, 32, 48, 128)


def generate_icons(source_path, output_dir, sizes=DEFAULT_SIZES):
    source = Path(source_path)
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)

    print(f"Generating icons from {source}...")

    with Image.open(source) as img:
        for size in sizes:
            resized_img = img.resize((size, size), Image.Resampling.LANCZOS)
            output_path = output / f"icon{size}.png"
            resized_img.save(output_path, "PNG")
            print(f"Saved {output_path}")

    print("Icon generation complete.")


def parse_args():
    parser = argparse.ArgumentParser(description="Generate PNG extension icons.")
    parser.add_argument("source", help="Source image path.")
    parser.add_argument(
        "--output",
        default=Path(__file__).resolve().parent,
        help="Output directory. Defaults to this icons folder.",
    )
    parser.add_argument(
        "--sizes",
        type=int,
        nargs="+",
        default=DEFAULT_SIZES,
        help="Icon sizes to generate.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    generate_icons(args.source, args.output, args.sizes)
