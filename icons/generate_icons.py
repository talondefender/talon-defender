import os
from PIL import Image

def generate_icons(source_path, output_dir):
    try:
        # Open the source image
        img = Image.open(source_path)
        
        # Define sizes
        sizes = [16, 32, 48, 128]
        
        if not os.path.exists(output_dir):
            os.makedirs(output_dir)
            
        print(f"Generating icons from {source_path}...")
        
        for size in sizes:
            # Resize image
            resized_img = img.resize((size, size), Image.Resampling.LANCZOS)
            
            # Save as PNG
            output_filename = f"icon{size}.png"
            output_path = os.path.join(output_dir, output_filename)
            resized_img.save(output_path, "PNG")
            print(f"Saved {output_path}")
            
        print("Icon generation complete.")
        
    except Exception as e:
        print(f"Error generating icons: {e}")

if __name__ == "__main__":
    # Source image path (using the uploaded image path from metadata)
    source_image = r"C:/Users/marty/.gemini/antigravity/brain/b2051dd2-a475-48c0-82aa-304a09a689e3/uploaded_image_1765934174869.png"
    
    # Output directory
    icons_dir = r"c:\dev\Talon Defender V2\icons"
    
    generate_icons(source_image, icons_dir)
