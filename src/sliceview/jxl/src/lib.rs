use std::ptr;
use std::alloc::{alloc, dealloc, Layout};
use std::slice;

use jxl_frame::header::Encoding;
use jxl_image::BitDepth;
use jxl_oxide::{FrameBuffer, JxlImage, PixelFormat};

#[no_mangle]
pub fn malloc(size: usize) -> *mut u8 {
    let layout = Layout::from_size_align(size, std::mem::align_of::<u8>()).unwrap();
    unsafe {
        let ptr = alloc(layout);
        if ptr.is_null() {
            panic!("Memory allocation failed");
        }
        ptr
    }
}

#[no_mangle]
pub fn free(ptr: *mut u8, size: usize) {
    let layout = Layout::from_size_align(size, std::mem::align_of::<u8>()).unwrap();
    unsafe {
        dealloc(ptr, layout);
    }
}

#[no_mangle]
pub fn height_and_width(ptr: *mut u8, input_size: usize) -> i64 {
    if ptr.is_null() || input_size == 0 {
        return -1;
    }

    let data: &[u8] = unsafe {
        slice::from_raw_parts(ptr, input_size)
    };

    match JxlImage::builder().read(data) {
        Ok(image) => (
            ((image.image_header().size.height as i64) << 31) | (((image.image_header().size.width as i64) & 0x7fffffff))
        ) as i64,
        Err(_) => -2,
    }
}

#[no_mangle]
pub fn decode(ptr: *mut u8, input_size: usize, output_size: usize) -> *const u8 {
    if ptr.is_null() || input_size == 0 || output_size == 0 {
        return ptr::null();
    }

    let data: &[u8] = unsafe {
        slice::from_raw_parts(ptr, input_size)
    };

    let image = match JxlImage::builder().read(data) {
        Ok(image) => image,
        Err(_image) => return std::ptr::null_mut(),
    };

    let mut output_buffer = Vec::with_capacity(output_size);

    for keyframe_idx in 0..image.num_loaded_keyframes() {
        let frame = match image.render_frame(keyframe_idx) {
            Ok(frame) => frame,
            Err(_frame) => return std::ptr::null_mut(),
        };

        let mut stream = frame.stream();
        let mut fb = FrameBuffer::new(
            stream.width() as usize,
            stream.height() as usize,
            stream.channels() as usize,
        );
        stream.write_to_buffer(fb.buf_mut());

        match image.pixel_format() {
            PixelFormat::Gray => {
                for pixel in fb.buf() {
                    let value = (pixel * 255.0).clamp(0.0, 255.0).round() as u8;
                    output_buffer.push(value);
                }
            },
            PixelFormat::Rgb => {
                for pixel in fb.buf() {
                    let value = (pixel * 255.0).clamp(0.0, 255.0).round() as u8;
                    output_buffer.push(value);
                }
            }
            PixelFormat::Rgba => {
                for pixel in fb.buf() {
                    let value = (pixel * 255.0).clamp(0.0, 255.0).round() as u8;
                    output_buffer.push(value);
                    output_buffer.push(255);  // Alpha channel set to fully opaque
                }
            }
            _ => return std::ptr::null_mut(),
        }
    }

    // Allocate memory in WASM and return a pointer and length
    let ptr = output_buffer.as_ptr();

    // Ensure that the memory is not dropped until after we return
    std::mem::forget(output_buffer);

    ptr
}



// Fields of the `info` that `decode_samples` fills in, as u32s.
const INFO_WIDTH: usize = 0;
const INFO_HEIGHT: usize = 1;
const INFO_CHANNELS: usize = 2;
const INFO_BITS: usize = 3;
const INFO_IS_FLOAT: usize = 4;
// 1 if the samples are exactly those the stream stores: the image is not XYB
// encoded, and its first frame is modular, not VarDCT.
const INFO_MODULAR_NOT_XYB: usize = 5;
const INFO_KEYFRAMES: usize = 6;

fn to_malloc_bytes<T: Copy>(samples: Vec<T>) -> *mut u8 {
    let size = samples.len() * std::mem::size_of::<T>();
    let out = malloc(size);
    unsafe {
        ptr::copy_nonoverlapping(samples.as_ptr() as *const u8, out, size);
    }
    out
}

/// Decodes the first keyframe to interleaved samples of the type of `kind`: 0
/// for u8, 1 for u16 and 2 for f32, as jxl-oxide renders them, in native byte
/// order. Unlike `decode`, the samples are not all scaled to 8 bits. Fills in
/// `info`, 7 u32s, and returns memory from `malloc`, or null if decoding fails.
#[no_mangle]
pub fn decode_samples(ptr: *mut u8, input_size: usize, kind: u32, info: *mut u32) -> *mut u8 {
    if ptr.is_null() || input_size == 0 || info.is_null() {
        return ptr::null_mut();
    }
    let data: &[u8] = unsafe { slice::from_raw_parts(ptr, input_size) };
    let image = match JxlImage::builder().read(data) {
        Ok(image) => image,
        Err(_) => return ptr::null_mut(),
    };
    let render = match image.render_frame(0) {
        Ok(render) => render,
        Err(_) => return ptr::null_mut(),
    };
    let mut stream = render.stream();
    let (width, height, channels) = (stream.width(), stream.height(), stream.channels());
    let length = (width as usize) * (height as usize) * (channels as usize);
    let out = match kind {
        0 => {
            let mut samples = vec![0u8; length];
            stream.write_to_buffer(&mut samples);
            to_malloc_bytes(samples)
        }
        1 => {
            let mut samples = vec![0u16; length];
            stream.write_to_buffer(&mut samples);
            to_malloc_bytes(samples)
        }
        2 => {
            let mut samples = vec![0f32; length];
            stream.write_to_buffer(&mut samples);
            to_malloc_bytes(samples)
        }
        _ => return ptr::null_mut(),
    };
    let metadata = &image.image_header().metadata;
    let modular = image
        .frame_header(0)
        .is_some_and(|header| matches!(header.encoding, Encoding::Modular));
    let fields = [
        (INFO_WIDTH, width),
        (INFO_HEIGHT, height),
        (INFO_CHANNELS, channels),
        (INFO_BITS, metadata.bit_depth.bits_per_sample()),
        (
            INFO_IS_FLOAT,
            matches!(metadata.bit_depth, BitDepth::FloatSample { .. }) as u32,
        ),
        (INFO_MODULAR_NOT_XYB, (modular && !metadata.xyb_encoded) as u32),
        (INFO_KEYFRAMES, image.num_loaded_keyframes() as u32),
    ];
    for (index, value) in fields {
        unsafe {
            *info.add(index) = value;
        }
    }
    out
}
