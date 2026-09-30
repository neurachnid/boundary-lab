"""Strict JSON-to-ctypes bridge for the bezopt C ABI."""

from __future__ import annotations

import array
import base64
import binascii
import ctypes
import math
import os
from pathlib import Path
import sys
from typing import Any


MAX_CHAINS = 50_000
MAX_CONTROL_POINTS = 2_000_000
MAX_SAMPLES = 5_000_000
MAX_RASTER_PIXELS = 4_000_000
MAX_SOURCE_POINTS = 4 * MAX_RASTER_PIXELS + MAX_CHAINS


class BezoptInputError(ValueError):
    """Raised when a UI payload cannot be represented by the native ABI."""


def _percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _distance_summary(values: list[float]) -> dict[str, Any]:
    return {
        "count": len(values),
        "median_px": _percentile(values, 0.5),
        "p95_px": _percentile(values, 0.95),
        "max_px": max(values) if values else None,
    }


def _cubic_point(points: list[list[float]], t: float) -> list[float]:
    u = 1.0 - t
    b0 = u * u * u
    b1 = 3.0 * u * u * t
    b2 = 3.0 * u * t * t
    b3 = t * t * t
    return [
        b0 * points[0][0]
        + b1 * points[1][0]
        + b2 * points[2][0]
        + b3 * points[3][0],
        b0 * points[0][1]
        + b1 * points[1][1]
        + b2 * points[2][1]
        + b3 * points[3][1],
    ]


def _target_correspondence_diagnostics(chains: list[dict[str, Any]]) -> dict[str, Any]:
    """Measure how the fitter's ordered target bins map to its initial cubics.

    This intentionally diagnoses the public fitted representation without changing
    it. Target bins are discrete observations, not a continuous source contour.
    """

    parameter_epsilon = 1e-9
    point_epsilon = 1e-7
    sample_count = 0
    segment_count = 0
    empty_segments = 0
    invalid_segments = 0
    clamped_parameters = 0
    coincident_parameters = 0
    collapsed_distinct_parameters = 0
    reversed_parameters = 0
    segment_order_reversals = 0
    segment_skips = 0
    assignment_euclidean_over_1px = 0
    assignment_normal_over_1px = 0
    join_gaps: list[float] = []
    knot_sample_gaps: list[float] = []
    euclidean_residuals: list[float] = []
    normal_residuals: list[float] = []

    def distance(a: list[float], b: list[float]) -> float:
        return math.hypot(a[0] - b[0], a[1] - b[1])

    for chain in chains:
        controls = chain["control_points"]
        closed = bool(chain["closed"])
        segments = len(controls) // 3 if closed else (len(controls) - 1) // 3
        segment_count += segments
        by_segment: list[list[dict[str, Any]]] = [[] for _ in range(segments)]
        previous_segment: int | None = None

        for sample in chain["samples"]:
            sample_count += 1
            segment = int(sample["segment"])
            if segment < 0 or segment >= segments:
                invalid_segments += 1
                continue
            if previous_segment is not None:
                if segment < previous_segment:
                    segment_order_reversals += 1
                elif segment > previous_segment + 1:
                    segment_skips += 1
            previous_segment = segment
            by_segment[segment].append(sample)

            t = float(sample["t"])
            if t <= parameter_epsilon or t >= 1.0 - parameter_epsilon:
                clamped_parameters += 1
            base = 3 * segment
            points = [controls[(base + index) % len(controls)] for index in range(4)]
            assigned = _cubic_point(points, t)
            delta = [assigned[0] - sample["point"][0], assigned[1] - sample["point"][1]]
            euclidean_residual = math.hypot(delta[0], delta[1])
            normal_residual = abs(
                delta[0] * sample["normal"][0]
                + delta[1] * sample["normal"][1]
            )
            euclidean_residuals.append(euclidean_residual)
            normal_residuals.append(normal_residual)
            assignment_euclidean_over_1px += euclidean_residual > 1.0
            assignment_normal_over_1px += normal_residual > 1.0

        for samples in by_segment:
            if not samples:
                empty_segments += 1
                continue
            for previous, current in zip(samples, samples[1:]):
                delta_t = float(current["t"]) - float(previous["t"])
                if delta_t < -parameter_epsilon:
                    reversed_parameters += 1
                elif abs(delta_t) <= parameter_epsilon:
                    if distance(previous["point"], current["point"]) > point_epsilon:
                        collapsed_distinct_parameters += 1
                    else:
                        coincident_parameters += 1

        for segment, samples in enumerate(by_segment):
            if not samples:
                continue
            base = 3 * segment
            start = controls[base % len(controls)]
            end = controls[(base + 3) % len(controls)]
            knot_sample_gaps.append(distance(start, samples[0]["point"]))
            knot_sample_gaps.append(distance(end, samples[-1]["point"]))

        join_pairs = segments if closed else max(0, segments - 1)
        for segment in range(join_pairs):
            next_segment = (segment + 1) % segments
            if by_segment[segment] and by_segment[next_segment]:
                join_gaps.append(
                    distance(
                        by_segment[segment][-1]["point"],
                        by_segment[next_segment][0]["point"],
                    )
                )

    return {
        "sample_count": sample_count,
        "segment_count": segment_count,
        "empty_segments": empty_segments,
        "invalid_segments": invalid_segments,
        "clamped_parameters": clamped_parameters,
        "coincident_parameters": coincident_parameters,
        "collapsed_distinct_parameters": collapsed_distinct_parameters,
        "reversed_parameters": reversed_parameters,
        "segment_order_reversals": segment_order_reversals,
        "segment_skips": segment_skips,
        "assignment_euclidean_over_1px": assignment_euclidean_over_1px,
        "assignment_normal_over_1px": assignment_normal_over_1px,
        "target_join_gap": _distance_summary(join_gaps),
        "knot_sample_gap": _distance_summary(knot_sample_gaps),
        "assignment_euclidean_residual": _distance_summary(euclidean_residuals),
        "assignment_normal_residual": _distance_summary(normal_residuals),
    }


class CSample(ctypes.Structure):
    _fields_ = [
        ("segment", ctypes.c_uint32),
        ("t", ctypes.c_double),
        ("x", ctypes.c_double),
        ("y", ctypes.c_double),
        ("nx", ctypes.c_double),
        ("ny", ctypes.c_double),
        ("weight", ctypes.c_double),
    ]


class CChain(ctypes.Structure):
    _fields_ = [
        ("control_xy", ctypes.POINTER(ctypes.c_double)),
        ("control_point_count", ctypes.c_size_t),
        ("samples", ctypes.POINTER(CSample)),
        ("sample_count", ctypes.c_size_t),
        ("left_region", ctypes.c_uint32),
        ("right_region", ctypes.c_uint32),
        ("closed", ctypes.c_int),
        ("corner_knots", ctypes.POINTER(ctypes.c_uint32)),
        ("corner_knot_count", ctypes.c_size_t),
    ]


class COptions(ctypes.Structure):
    _fields_ = [
        ("max_sweeps", ctypes.c_uint32),
        ("local_iterations", ctypes.c_uint32),
        ("lbfgs_history", ctypes.c_uint32),
        ("coarse_sample_stride", ctypes.c_uint32),
        ("threads", ctypes.c_int),
        ("normalization", ctypes.c_uint32),
        ("coordinate_scale", ctypes.c_double),
        ("data_weight", ctypes.c_double),
        ("tangent_weight", ctypes.c_double),
        ("robust_delta_px", ctypes.c_double),
        ("angle_weight", ctypes.c_double),
        ("handle_weight", ctypes.c_double),
        ("length_weight", ctypes.c_double),
        ("angle_epsilon_rad", ctypes.c_double),
        ("handle_epsilon_px", ctypes.c_double),
        ("max_step_px", ctypes.c_double),
        ("gradient_tolerance", ctypes.c_double),
        ("relative_tolerance", ctypes.c_double),
        ("max_line_search_steps", ctypes.c_uint32),
        ("reproject_samples", ctypes.c_int),
        ("projection_iterations", ctypes.c_uint32),
        ("preserve_topology", ctypes.c_int),
        ("topology_retries", ctypes.c_uint32),
        ("topology_flatness_px", ctypes.c_double),
        ("topology_cell_size_px", ctypes.c_double),
    ]


class CReport(ctypes.Structure):
    _fields_ = [
        ("status", ctypes.c_uint32),
        ("sweeps", ctypes.c_uint32),
        ("blocks_optimized", ctypes.c_uint64),
        ("function_evaluations", ctypes.c_uint64),
        ("sample_evaluations", ctypes.c_uint64),
        ("topology_rejections", ctypes.c_uint32),
        ("initial_energy", ctypes.c_double),
        ("final_energy", ctypes.c_double),
        ("initial_normal_rmse_px", ctypes.c_double),
        ("final_normal_rmse_px", ctypes.c_double),
        ("elapsed_ms", ctypes.c_double),
        ("converged", ctypes.c_int),
    ]


class CPreprocessOptions(ctypes.Structure):
    _fields_ = [
        ("target_regions", ctypes.c_uint32),
        ("criterion", ctypes.c_uint32),
        ("iterations", ctypes.c_uint32),
        ("area_exponent", ctypes.c_double),
        ("area_smallness_scale", ctypes.c_double),
        ("area_raster_bias", ctypes.c_double),
        ("saliency_weight", ctypes.c_double),
        ("topology_weight", ctypes.c_double),
    ]


class CRgb8View(ctypes.Structure):
    _fields_ = [
        ("rgb", ctypes.POINTER(ctypes.c_uint8)),
        ("width", ctypes.c_size_t),
        ("height", ctypes.c_size_t),
        ("row_stride_bytes", ctypes.c_size_t),
        ("color_space", ctypes.c_uint32),
        ("initial_labels", ctypes.POINTER(ctypes.c_uint32)),
        ("label_row_stride", ctypes.c_size_t),
        ("initial_region_count", ctypes.c_uint32),
    ]


class CPreprocessRegion(ctypes.Structure):
    _fields_ = [
        ("id", ctypes.c_uint32),
        ("source_id", ctypes.c_uint32),
        ("pixel_count", ctypes.c_uint64),
        ("perimeter", ctypes.c_double),
        ("centroid_x", ctypes.c_double),
        ("centroid_y", ctypes.c_double),
        ("touches_border", ctypes.c_int),
    ]


class CPreprocessEdge(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_uint32),
        ("right", ctypes.c_uint32),
        ("shared_boundary", ctypes.c_double),
        ("protected_boundary", ctypes.c_double),
        ("locked_raster_edges", ctypes.c_uint32),
    ]


class CPreprocessMerge(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_uint32),
        ("right", ctypes.c_uint32),
        ("merged", ctypes.c_uint32),
        ("cost", ctypes.c_double),
        ("region_count", ctypes.c_uint32),
    ]


class CPreprocessResult(ctypes.Structure):
    _fields_ = [
        ("status", ctypes.c_uint32),
        ("width", ctypes.c_size_t),
        ("height", ctypes.c_size_t),
        ("channels", ctypes.c_size_t),
        ("initial_regions", ctypes.c_uint32),
        ("final_regions", ctypes.c_uint32),
        ("lambda_star", ctypes.c_double),
        ("elapsed_ms", ctypes.c_double),
        ("target_reached", ctypes.c_int),
        ("labels", ctypes.POINTER(ctypes.c_uint32)),
        ("label_count", ctypes.c_size_t),
        ("regions", ctypes.POINTER(CPreprocessRegion)),
        ("region_count", ctypes.c_size_t),
        ("mean_colors", ctypes.POINTER(ctypes.c_double)),
        ("mean_color_count", ctypes.c_size_t),
        ("edges", ctypes.POINTER(CPreprocessEdge)),
        ("edge_count", ctypes.c_size_t),
        ("merge_history", ctypes.POINTER(CPreprocessMerge)),
        ("merge_count", ctypes.c_size_t),
    ]


class CLabelRasterView(ctypes.Structure):
    _fields_ = [
        ("labels", ctypes.POINTER(ctypes.c_uint32)),
        ("width", ctypes.c_size_t),
        ("height", ctypes.c_size_t),
        ("label_row_stride", ctypes.c_size_t),
        ("region_count", ctypes.c_uint32),
        ("region_linear_rgb", ctypes.POINTER(ctypes.c_double)),
        ("region_color_stride", ctypes.c_size_t),
        ("pixel_srgb8", ctypes.POINTER(ctypes.c_uint8)),
        ("pixel_srgb_row_stride_bytes", ctypes.c_size_t),
    ]


class CFitOptions(ctypes.Structure):
    _fields_ = [
        ("coordinate_scale", ctypes.c_double),
        ("max_error_px", ctypes.c_double),
        ("residual_sigmas", ctypes.c_double),
        ("excursion_sigmas", ctypes.c_double),
        ("samples_per_cubic", ctypes.c_uint32),
        ("reparameterization_iterations", ctypes.c_uint32),
        ("corner_angle_degrees", ctypes.c_double),
        ("corner_window", ctypes.c_uint32),
        ("corner_run_edges", ctypes.c_uint32),
        ("corner_scale_octaves", ctypes.c_uint32),
        ("corner_scale_growth", ctypes.c_double),
        ("guide_smoothing", ctypes.c_double),
        ("topology_retries", ctypes.c_uint32),
        ("preserve_topology", ctypes.c_int),
        ("max_cubics_per_chain", ctypes.c_uint32),
        ("max_total_cubics", ctypes.c_uint64),
        ("contrast_floor", ctypes.c_double),
        ("threads", ctypes.c_int),
        ("refine_subpixel", ctypes.c_int),
        ("max_subpixel_offset_px", ctypes.c_double),
        ("subpixel_anchor_weight", ctypes.c_double),
    ]


class CFitChain(ctypes.Structure):
    _fields_ = [
        ("control_point_offset", ctypes.c_size_t),
        ("control_point_count", ctypes.c_size_t),
        ("sample_offset", ctypes.c_size_t),
        ("sample_count", ctypes.c_size_t),
        ("left_region", ctypes.c_uint32),
        ("right_region", ctypes.c_uint32),
        ("closed", ctypes.c_int),
        ("source_point_offset", ctypes.c_size_t),
        ("source_point_count", ctypes.c_size_t),
        ("corner_knot_offset", ctypes.c_size_t),
        ("corner_knot_count", ctypes.c_size_t),
    ]


class CFitReport(ctypes.Structure):
    _fields_ = [
        ("status", ctypes.c_uint32),
        ("raster_boundary_edges", ctypes.c_uint64),
        ("raw_vertices", ctypes.c_uint64),
        ("pinned_vertices", ctypes.c_uint64),
        ("open_chains", ctypes.c_uint64),
        ("closed_chains", ctypes.c_uint64),
        ("cubics", ctypes.c_uint64),
        ("target_samples", ctypes.c_uint64),
        ("topology_refits", ctypes.c_uint32),
        ("recovered_chains", ctypes.c_uint64),
        ("grid_fallback_chains", ctypes.c_uint64),
        ("grid_fallback_cubics", ctypes.c_uint64),
        ("grid_fallback_length_px", ctypes.c_double),
        ("unconstrained_cubics", ctypes.c_uint64),
        ("unconstrained_length_px", ctypes.c_double),
        ("curve_to_contour_px", ctypes.c_double),
        ("max_curve_to_contour_px", ctypes.c_double),
        ("contour_to_curve_px", ctypes.c_double),
        ("accepted_error_px", ctypes.c_double),
        ("prepare_ms", ctypes.c_double),
        ("trace_ms", ctypes.c_double),
        ("fit_ms", ctypes.c_double),
        ("elapsed_ms", ctypes.c_double),
        ("used_grid_fallback", ctypes.c_int),
        ("subpixel_edges", ctypes.c_uint64),
        ("mean_abs_subpixel_offset_px", ctypes.c_double),
        ("max_abs_subpixel_offset_px", ctypes.c_double),
        ("mean_edge_confidence", ctypes.c_double),
        ("detected_corners", ctypes.c_uint64),
        ("smoothed_guide_vertices", ctypes.c_uint64),
        ("mean_guide_displacement_px", ctypes.c_double),
        ("max_guide_displacement_px", ctypes.c_double),
    ]


class CFitResult(ctypes.Structure):
    _fields_ = [
        ("report", CFitReport),
        ("chains", ctypes.POINTER(CFitChain)),
        ("chain_count", ctypes.c_size_t),
        ("control_xy", ctypes.POINTER(ctypes.c_double)),
        ("control_point_count", ctypes.c_size_t),
        ("samples", ctypes.POINTER(CSample)),
        ("sample_count", ctypes.c_size_t),
        ("source_xy", ctypes.POINTER(ctypes.c_double)),
        ("source_point_count", ctypes.c_size_t),
        ("corner_knots", ctypes.POINTER(ctypes.c_uint32)),
        ("corner_knot_count", ctypes.c_size_t),
    ]


class CRasterView(ctypes.Structure):
    _fields_ = [
        ("labels", ctypes.POINTER(ctypes.c_uint32)),
        ("width", ctypes.c_size_t),
        ("height", ctypes.c_size_t),
        ("label_row_stride", ctypes.c_size_t),
        ("region_count", ctypes.c_uint32),
        ("region_linear_rgb", ctypes.POINTER(ctypes.c_double)),
        ("region_color_stride", ctypes.c_size_t),
        ("source_srgb8", ctypes.POINTER(ctypes.c_uint8)),
        ("source_srgb_row_stride_bytes", ctypes.c_size_t),
        ("optimized_region_rgb", ctypes.POINTER(ctypes.c_double)),
        ("optimized_region_color_stride", ctypes.c_size_t),
    ]


class CRasterOptions(ctypes.Structure):
    _fields_ = [
        ("samples_per_axis", ctypes.c_uint32),
        ("band_height_px", ctypes.c_uint32),
        ("threads", ctypes.c_int),
        ("color_space", ctypes.c_uint32),
        ("fixed_initial_length_px", ctypes.c_double),
        ("max_transition_error_ratio", ctypes.c_double),
    ]


class CRasterReport(ctypes.Structure):
    _fields_ = [
        ("status", ctypes.c_uint32),
        ("subpixel_samples", ctypes.c_uint64),
        ("cubic_tests", ctypes.c_uint64),
        ("crossings", ctypes.c_uint64),
        ("transition_errors", ctypes.c_uint64),
        ("bands", ctypes.c_uint32),
        ("initial_length_px", ctypes.c_double),
        ("squared_error", ctypes.c_double),
        ("yang_data_energy", ctypes.c_double),
        ("mse", ctypes.c_double),
        ("psnr_db", ctypes.c_double),
        ("index_ms", ctypes.c_double),
        ("render_ms", ctypes.c_double),
        ("elapsed_ms", ctypes.c_double),
    ]


class CRasterResult(ctypes.Structure):
    _fields_ = [
        ("report", CRasterReport),
        ("srgb8", ctypes.POINTER(ctypes.c_uint8)),
        ("srgb8_size", ctypes.c_size_t),
    ]


class CRasterOptimizeOptions(ctypes.Structure):
    _fields_ = [
        ("max_sweeps", ctypes.c_uint32),
        ("samples_per_axis", ctypes.c_uint32),
        ("band_height_px", ctypes.c_uint32),
        ("threads", ctypes.c_int),
        ("color_space", ctypes.c_uint32),
        ("fixed_initial_length_px", ctypes.c_double),
        ("geometry_solver", ctypes.c_uint32),
        ("normalization", ctypes.c_uint32),
        ("coordinate_scale", ctypes.c_double),
        ("step_scale", ctypes.c_double),
        ("hessian_damping", ctypes.c_double),
        ("max_step_px", ctypes.c_double),
        ("max_line_search_steps", ctypes.c_uint32),
        ("relative_tolerance", ctypes.c_double),
        ("angle_weight", ctypes.c_double),
        ("handle_weight", ctypes.c_double),
        ("length_weight", ctypes.c_double),
        ("angle_epsilon_rad", ctypes.c_double),
        ("handle_epsilon_px", ctypes.c_double),
        ("active_margin_px", ctypes.c_double),
        ("preserve_topology", ctypes.c_int),
        ("topology_flatness_px", ctypes.c_double),
        ("topology_cell_size_px", ctypes.c_double),
        ("optimize_region_colors", ctypes.c_int),
        ("color_solve_iterations", ctypes.c_uint32),
        ("color_regularization", ctypes.c_double),
        ("color_tolerance", ctypes.c_double),
        ("block_schedule", ctypes.c_uint32),
    ]


class CRasterOptimizeReport(ctypes.Structure):
    _fields_ = [
        ("status", ctypes.c_uint32),
        ("sweeps", ctypes.c_uint32),
        ("line_search_evaluations", ctypes.c_uint32),
        ("topology_rejections", ctypes.c_uint32),
        ("active_pixels", ctypes.c_uint64),
        ("subpixel_samples", ctypes.c_uint64),
        ("cubic_tests", ctypes.c_uint64),
        ("gradient_intervals", ctypes.c_uint64),
        ("geometry_blocks", ctypes.c_uint64),
        ("geometry_batches", ctypes.c_uint64),
        ("block_solve_fallbacks", ctypes.c_uint64),
        ("initial_length_px", ctypes.c_double),
        ("initial_active_squared_error", ctypes.c_double),
        ("final_active_squared_error", ctypes.c_double),
        ("initial_data_energy", ctypes.c_double),
        ("final_data_energy", ctypes.c_double),
        ("initial_prior_energy", ctypes.c_double),
        ("final_prior_energy", ctypes.c_double),
        ("initial_objective", ctypes.c_double),
        ("final_objective", ctypes.c_double),
        ("maximum_control_step_px", ctypes.c_double),
        ("color_solves", ctypes.c_uint32),
        ("color_solve_iterations", ctypes.c_uint32),
        ("initial_full_squared_error", ctypes.c_double),
        ("final_full_squared_error", ctypes.c_double),
        ("initial_full_data_energy", ctypes.c_double),
        ("final_full_data_energy", ctypes.c_double),
        ("maximum_color_change", ctypes.c_double),
        ("elapsed_ms", ctypes.c_double),
        ("converged", ctypes.c_int),
    ]


class CSvgView(ctypes.Structure):
    _fields_ = [
        ("width", ctypes.c_size_t),
        ("height", ctypes.c_size_t),
        ("region_count", ctypes.c_uint32),
        ("region_srgb", ctypes.POINTER(ctypes.c_double)),
        ("region_color_stride", ctypes.c_size_t),
        ("region_touches_frame", ctypes.POINTER(ctypes.c_uint8)),
    ]


class CSvgReport(ctypes.Structure):
    _fields_ = [
        ("status", ctypes.c_uint32),
        ("region_count", ctypes.c_uint32),
        ("loop_count", ctypes.c_uint32),
        ("path_count", ctypes.c_uint32),
        ("elapsed_ms", ctypes.c_double),
    ]


class CSvgResult(ctypes.Structure):
    _fields_ = [
        ("report", CSvgReport),
        ("svg_utf8", ctypes.c_char_p),
        ("svg_utf8_size", ctypes.c_size_t),
    ]


_UINT_OPTIONS = {
    "max_sweeps",
    "local_iterations",
    "lbfgs_history",
    "coarse_sample_stride",
    "max_line_search_steps",
    "projection_iterations",
    "topology_retries",
}
_DOUBLE_OPTIONS = {
    "coordinate_scale",
    "data_weight",
    "tangent_weight",
    "robust_delta_px",
    "angle_weight",
    "handle_weight",
    "length_weight",
    "angle_epsilon_rad",
    "handle_epsilon_px",
    "max_step_px",
    "gradient_tolerance",
    "relative_tolerance",
    "topology_flatness_px",
    "topology_cell_size_px",
}
_BOOL_OPTIONS = {"reproject_samples", "preserve_topology"}
_NORMALIZATION_MODES = {"none": 0, "yang": 1, "scale": 2}
_OPTION_NAMES = (
    _UINT_OPTIONS | _DOUBLE_OPTIONS | _BOOL_OPTIONS | {"threads", "normalization"}
)

_PREPROCESS_CRITERIA = {"bg": 0, "ms": 1, "scale": 2, "area": 3}
_PREPROCESS_COLOR_SPACES = {"rgb": 0, "linear": 1, "lab": 2, "oklab": 3}
_PREPROCESS_UINT_OPTIONS = {"target_regions", "iterations"}
_PREPROCESS_DOUBLE_OPTIONS = {
    "area_exponent",
    "area_smallness_scale",
    "area_raster_bias",
    "saliency_weight",
    "topology_weight",
}
_PREPROCESS_OPTION_NAMES = (
    _PREPROCESS_UINT_OPTIONS | _PREPROCESS_DOUBLE_OPTIONS | {"criterion"}
)
_FIT_UINT_OPTIONS = {
    "samples_per_cubic",
    "reparameterization_iterations",
    "corner_window",
    "corner_run_edges",
    "corner_scale_octaves",
    "topology_retries",
    "max_cubics_per_chain",
}
_FIT_UINT64_OPTIONS = {"max_total_cubics"}
_FIT_DOUBLE_OPTIONS = {
    "coordinate_scale",
    "max_error_px",
    "residual_sigmas",
    "excursion_sigmas",
    "corner_angle_degrees",
    "corner_scale_growth",
    "guide_smoothing",
    "contrast_floor",
    "max_subpixel_offset_px",
    "subpixel_anchor_weight",
}
_FIT_BOOL_OPTIONS = {"preserve_topology", "refine_subpixel"}
_FIT_OPTION_NAMES = (
    _FIT_UINT_OPTIONS | _FIT_UINT64_OPTIONS | _FIT_DOUBLE_OPTIONS |
    _FIT_BOOL_OPTIONS | {"threads"}
)
_RASTER_UINT_OPTIONS = {"samples_per_axis", "band_height_px"}
_RASTER_DOUBLE_OPTIONS = {"fixed_initial_length_px", "max_transition_error_ratio"}
_RASTER_COLOR_SPACES = {"srgb": 0, "linear": 1}
_RASTER_GEOMETRY_SOLVERS = {"diagonal": 0, "overlapping_blocks": 1}
_RASTER_BLOCK_SCHEDULES = {"additive": 0, "colored_multiplicative": 1}
_RASTER_NORMALIZATION_MODES = {"none": 0, "yang": 1}
_RASTER_OPTION_NAMES = (
    _RASTER_UINT_OPTIONS | _RASTER_DOUBLE_OPTIONS | {"threads", "color_space"}
)
_RASTER_OPTIMIZE_UINT_OPTIONS = {
    "max_sweeps",
    "samples_per_axis",
    "band_height_px",
    "max_line_search_steps",
    "color_solve_iterations",
}
_RASTER_OPTIMIZE_DOUBLE_OPTIONS = {
    "coordinate_scale",
    "fixed_initial_length_px",
    "step_scale",
    "hessian_damping",
    "max_step_px",
    "relative_tolerance",
    "angle_weight",
    "handle_weight",
    "length_weight",
    "angle_epsilon_rad",
    "handle_epsilon_px",
    "active_margin_px",
    "topology_flatness_px",
    "topology_cell_size_px",
    "color_regularization",
    "color_tolerance",
}
_RASTER_OPTIMIZE_BOOL_OPTIONS = {"preserve_topology", "optimize_region_colors"}
_RASTER_OPTIMIZE_OPTION_NAMES = (
    _RASTER_OPTIMIZE_UINT_OPTIONS | _RASTER_OPTIMIZE_DOUBLE_OPTIONS |
    _RASTER_OPTIMIZE_BOOL_OPTIONS |
    {
        "threads",
        "color_space",
        "geometry_solver",
        "block_schedule",
        "normalization",
    }
)


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise BezoptInputError(f"{label} must be numeric")
    try:
        converted = float(value)
    except (TypeError, ValueError) as exc:
        raise BezoptInputError(f"{label} must be numeric") from exc
    if not math.isfinite(converted):
        raise BezoptInputError(f"{label} must be finite")
    return converted


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise BezoptInputError(f"{label} must be an integer")
    if value < minimum or value > maximum:
        raise BezoptInputError(f"{label} is out of range")
    return value


def _pair(value: Any, label: str) -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise BezoptInputError(f"{label} must be [x, y]")
    return _finite_number(value[0], f"{label}[0]"), _finite_number(value[1], f"{label}[1]")


def _prepare_windows_dll_search(library_path: Path) -> None:
    if sys.platform != "win32" or not hasattr(os, "add_dll_directory"):
        return
    os.add_dll_directory(str(library_path.parent))
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        if not directory:
            continue
        try:
            os.add_dll_directory(directory)
        except OSError:
            continue


class BezoptLibrary:
    """Owns a loaded bezopt shared library and marshals one request at a time."""

    def __init__(self, library_path: str | Path):
        path = Path(library_path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"bezopt shared library not found: {path}")
        self.path = path
        _prepare_windows_dll_search(path)
        self._library = ctypes.CDLL(str(path))
        self._library.bezopt_default_options.argtypes = []
        self._library.bezopt_default_options.restype = COptions
        self._library.bezopt_optimize.argtypes = [
            ctypes.POINTER(CChain),
            ctypes.c_size_t,
            ctypes.POINTER(COptions),
            ctypes.POINTER(CReport),
        ]
        self._library.bezopt_optimize.restype = ctypes.c_uint32
        self._library.bezopt_status_string.argtypes = [ctypes.c_uint32]
        self._library.bezopt_status_string.restype = ctypes.c_char_p
        self._library.bezopt_default_preprocess_options.argtypes = []
        self._library.bezopt_default_preprocess_options.restype = CPreprocessOptions
        self._library.bezopt_preprocess_rgb8.argtypes = [
            ctypes.POINTER(CRgb8View),
            ctypes.POINTER(CPreprocessOptions),
            ctypes.POINTER(CPreprocessResult),
        ]
        self._library.bezopt_preprocess_rgb8.restype = ctypes.c_uint32
        self._library.bezopt_free_preprocess_result.argtypes = [
            ctypes.POINTER(CPreprocessResult)
        ]
        self._library.bezopt_free_preprocess_result.restype = None
        self._library.bezopt_preprocess_status_string.argtypes = [ctypes.c_uint32]
        self._library.bezopt_preprocess_status_string.restype = ctypes.c_char_p
        self._library.bezopt_default_fit_options.argtypes = []
        self._library.bezopt_default_fit_options.restype = CFitOptions
        self._library.bezopt_fit_boundaries.argtypes = [
            ctypes.POINTER(CLabelRasterView),
            ctypes.POINTER(CFitOptions),
            ctypes.POINTER(CFitResult),
        ]
        self._library.bezopt_fit_boundaries.restype = ctypes.c_uint32
        self._library.bezopt_free_fit_result.argtypes = [ctypes.POINTER(CFitResult)]
        self._library.bezopt_free_fit_result.restype = None
        self._library.bezopt_fit_status_string.argtypes = [ctypes.c_uint32]
        self._library.bezopt_fit_status_string.restype = ctypes.c_char_p
        self._library.bezopt_default_raster_options.argtypes = []
        self._library.bezopt_default_raster_options.restype = CRasterOptions
        self._library.bezopt_render_reference.argtypes = [
            ctypes.POINTER(CChain),
            ctypes.c_size_t,
            ctypes.POINTER(CRasterView),
            ctypes.POINTER(CRasterOptions),
            ctypes.POINTER(CRasterResult),
        ]
        self._library.bezopt_render_reference.restype = ctypes.c_uint32
        self._library.bezopt_free_raster_result.argtypes = [
            ctypes.POINTER(CRasterResult)
        ]
        self._library.bezopt_free_raster_result.restype = None
        self._library.bezopt_raster_status_string.argtypes = [ctypes.c_uint32]
        self._library.bezopt_raster_status_string.restype = ctypes.c_char_p
        self._library.bezopt_default_raster_optimize_options.argtypes = []
        self._library.bezopt_default_raster_optimize_options.restype = (
            CRasterOptimizeOptions
        )
        self._library.bezopt_optimize_raster.argtypes = [
            ctypes.POINTER(CChain),
            ctypes.c_size_t,
            ctypes.POINTER(CRasterView),
            ctypes.POINTER(CRasterOptimizeOptions),
            ctypes.POINTER(CRasterOptimizeReport),
        ]
        self._library.bezopt_optimize_raster.restype = ctypes.c_uint32
        self._library.bezopt_export_flat_svg.argtypes = [
            ctypes.POINTER(CChain),
            ctypes.c_size_t,
            ctypes.POINTER(CSvgView),
            ctypes.POINTER(CSvgResult),
        ]
        self._library.bezopt_export_flat_svg.restype = ctypes.c_uint32
        self._library.bezopt_free_svg_result.argtypes = [ctypes.POINTER(CSvgResult)]
        self._library.bezopt_free_svg_result.restype = None

    def defaults(self) -> dict[str, Any]:
        options = self._library.bezopt_default_options()
        result: dict[str, Any] = {}
        for name, _ctype in COptions._fields_:
            value = getattr(options, name)
            if name in _BOOL_OPTIONS:
                result[name] = bool(value)
            elif name == "normalization":
                result[name] = next(
                    key for key, mode in _NORMALIZATION_MODES.items() if mode == value
                )
            else:
                result[name] = value
        return result

    def _options(self, overrides: Any) -> COptions:
        options = self._library.bezopt_default_options()
        if overrides is None:
            return options
        if not isinstance(overrides, dict):
            raise BezoptInputError("options must be an object")
        unknown = sorted(set(overrides) - _OPTION_NAMES)
        if unknown:
            raise BezoptInputError(f"unknown optimizer option: {unknown[0]}")
        for name, value in overrides.items():
            if name in _UINT_OPTIONS:
                converted: Any = _integer(value, f"options.{name}", 0, 2**32 - 1)
            elif name in _DOUBLE_OPTIONS:
                converted = _finite_number(value, f"options.{name}")
            elif name in _BOOL_OPTIONS:
                if not isinstance(value, bool):
                    raise BezoptInputError(f"options.{name} must be boolean")
                converted = int(value)
            elif name == "normalization":
                if value not in _NORMALIZATION_MODES:
                    raise BezoptInputError("options.normalization is unknown")
                converted = _NORMALIZATION_MODES[value]
            else:
                converted = _integer(value, "options.threads", -(2**31), 2**31 - 1)
            setattr(options, name, converted)
        return options

    def preprocess_defaults(self) -> dict[str, Any]:
        options = self._library.bezopt_default_preprocess_options()
        result = {name: getattr(options, name) for name, _ctype in CPreprocessOptions._fields_}
        result["criterion"] = next(
            name for name, value in _PREPROCESS_CRITERIA.items() if value == options.criterion
        )
        return result

    def _preprocess_options(self, overrides: Any) -> CPreprocessOptions:
        options = self._library.bezopt_default_preprocess_options()
        if overrides is None:
            return options
        if not isinstance(overrides, dict):
            raise BezoptInputError("options must be an object")
        unknown = sorted(set(overrides) - _PREPROCESS_OPTION_NAMES)
        if unknown:
            raise BezoptInputError(f"unknown preprocessor option: {unknown[0]}")
        for name, value in overrides.items():
            if name == "criterion":
                if value not in _PREPROCESS_CRITERIA:
                    raise BezoptInputError("options.criterion is unknown")
                converted: Any = _PREPROCESS_CRITERIA[value]
            elif name in _PREPROCESS_UINT_OPTIONS:
                converted = _integer(value, f"options.{name}", 1, 2**32 - 1)
            else:
                converted = _finite_number(value, f"options.{name}")
            setattr(options, name, converted)
        return options

    def fit_defaults(self) -> dict[str, Any]:
        options = self._library.bezopt_default_fit_options()
        result: dict[str, Any] = {}
        for name, _ctype in CFitOptions._fields_:
            value = getattr(options, name)
            result[name] = bool(value) if name in _FIT_BOOL_OPTIONS else value
        return result

    def raster_defaults(self) -> dict[str, Any]:
        options = self._library.bezopt_default_raster_options()
        result = {
            name: getattr(options, name)
            for name, _ctype in CRasterOptions._fields_
        }
        result["color_space"] = next(
            name
            for name, value in _RASTER_COLOR_SPACES.items()
            if value == options.color_space
        )
        return result

    def raster_optimize_defaults(self) -> dict[str, Any]:
        options = self._library.bezopt_default_raster_optimize_options()
        result: dict[str, Any] = {}
        for name, _ctype in CRasterOptimizeOptions._fields_:
            value = getattr(options, name)
            if name in _RASTER_OPTIMIZE_BOOL_OPTIONS:
                result[name] = bool(value)
            elif name == "color_space":
                result[name] = next(
                    key
                    for key, mode in _RASTER_COLOR_SPACES.items()
                    if mode == value
                )
            elif name == "geometry_solver":
                result[name] = next(
                    key
                    for key, mode in _RASTER_GEOMETRY_SOLVERS.items()
                    if mode == value
                )
            elif name == "block_schedule":
                result[name] = next(
                    key
                    for key, mode in _RASTER_BLOCK_SCHEDULES.items()
                    if mode == value
                )
            elif name == "normalization":
                result[name] = next(
                    key
                    for key, mode in _RASTER_NORMALIZATION_MODES.items()
                    if mode == value
                )
            else:
                result[name] = value
        return result

    def _raster_options(self, overrides: Any) -> CRasterOptions:
        options = self._library.bezopt_default_raster_options()
        if overrides is None:
            return options
        if not isinstance(overrides, dict):
            raise BezoptInputError("options must be an object")
        unknown = sorted(set(overrides) - _RASTER_OPTION_NAMES)
        if unknown:
            raise BezoptInputError(f"unknown raster option: {unknown[0]}")
        for name, value in overrides.items():
            if name in _RASTER_UINT_OPTIONS:
                maximum = 32 if name == "samples_per_axis" else 2**32 - 1
                converted: Any = _integer(value, f"options.{name}", 1, maximum)
            elif name in _RASTER_DOUBLE_OPTIONS:
                converted = _finite_number(value, f"options.{name}")
            elif name == "color_space":
                if value not in _RASTER_COLOR_SPACES:
                    raise BezoptInputError("options.color_space is unknown")
                converted = _RASTER_COLOR_SPACES[value]
            else:
                converted = _integer(value, "options.threads", 0, 2**31 - 1)
            setattr(options, name, converted)
        return options

    def _raster_optimize_options(self, overrides: Any) -> CRasterOptimizeOptions:
        options = self._library.bezopt_default_raster_optimize_options()
        if overrides is None:
            return options
        if not isinstance(overrides, dict):
            raise BezoptInputError("options must be an object")
        unknown = sorted(set(overrides) - _RASTER_OPTIMIZE_OPTION_NAMES)
        if unknown:
            raise BezoptInputError(f"unknown raster optimizer option: {unknown[0]}")
        for name, value in overrides.items():
            if name in _RASTER_OPTIMIZE_UINT_OPTIONS:
                maximum = 32 if name == "samples_per_axis" else 2**32 - 1
                converted: Any = _integer(value, f"options.{name}", 1, maximum)
            elif name in _RASTER_OPTIMIZE_DOUBLE_OPTIONS:
                converted = _finite_number(value, f"options.{name}")
            elif name in _RASTER_OPTIMIZE_BOOL_OPTIONS:
                if not isinstance(value, bool):
                    raise BezoptInputError(f"options.{name} must be boolean")
                converted = int(value)
            elif name == "color_space":
                if value not in _RASTER_COLOR_SPACES:
                    raise BezoptInputError("options.color_space is unknown")
                converted = _RASTER_COLOR_SPACES[value]
            elif name == "geometry_solver":
                if value not in _RASTER_GEOMETRY_SOLVERS:
                    raise BezoptInputError("options.geometry_solver is unknown")
                converted = _RASTER_GEOMETRY_SOLVERS[value]
            elif name == "block_schedule":
                if value not in _RASTER_BLOCK_SCHEDULES:
                    raise BezoptInputError("options.block_schedule is unknown")
                converted = _RASTER_BLOCK_SCHEDULES[value]
            elif name == "normalization":
                if value not in _RASTER_NORMALIZATION_MODES:
                    raise BezoptInputError("options.normalization is unknown")
                converted = _RASTER_NORMALIZATION_MODES[value]
            else:
                converted = _integer(value, "options.threads", 0, 2**31 - 1)
            setattr(options, name, converted)
        return options

    def _fit_options(self, overrides: Any) -> CFitOptions:
        options = self._library.bezopt_default_fit_options()
        if overrides is None:
            return options
        if not isinstance(overrides, dict):
            raise BezoptInputError("options must be an object")
        unknown = sorted(set(overrides) - _FIT_OPTION_NAMES)
        if unknown:
            raise BezoptInputError(f"unknown fitter option: {unknown[0]}")
        for name, value in overrides.items():
            if name in _FIT_UINT_OPTIONS:
                minimum = 0 if name in {
                    "reparameterization_iterations", "topology_retries",
                    "corner_run_edges", "corner_scale_octaves",
                } else 1
                converted: Any = _integer(
                    value, f"options.{name}", minimum, 2**32 - 1
                )
            elif name in _FIT_UINT64_OPTIONS:
                converted = _integer(value, f"options.{name}", 1, 2**63 - 1)
            elif name in _FIT_DOUBLE_OPTIONS:
                converted = _finite_number(value, f"options.{name}")
            elif name in _FIT_BOOL_OPTIONS:
                if not isinstance(value, bool):
                    raise BezoptInputError(f"options.{name} must be boolean")
                converted = int(value)
            else:
                converted = _integer(value, "options.threads", -(2**31), 2**31 - 1)
            setattr(options, name, converted)
        return options

    @staticmethod
    def _decode_base64(value: Any, label: str) -> bytes:
        if not isinstance(value, str) or not value:
            raise BezoptInputError(f"{label} must be non-empty base64")
        try:
            return base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise BezoptInputError(f"{label} must be valid base64") from exc

    @staticmethod
    def _label_buffer(
        value: Any,
        pixels: int,
        label: str = "initial_labels_base64",
    ) -> Any:
        if value is None:
            return None
        raw = BezoptLibrary._decode_base64(value, label)
        if len(raw) != pixels * 4:
            raise BezoptInputError(f"{label} has the wrong byte length")
        if ctypes.sizeof(ctypes.c_uint32) != 4:
            raise RuntimeError("native unsigned integers are not 32-bit")
        if sys.byteorder == "little":
            return (ctypes.c_uint32 * pixels).from_buffer_copy(raw)
        labels = array.array("I")
        labels.frombytes(raw)
        labels.byteswap()
        return (ctypes.c_uint32 * pixels).from_buffer_copy(labels)

    @staticmethod
    def _labels_base64(pointer: Any, count: int) -> str:
        raw = ctypes.string_at(pointer, count * 4)
        if sys.byteorder != "little":
            labels = array.array("I")
            labels.frombytes(raw)
            labels.byteswap()
            raw = labels.tobytes()
        return base64.b64encode(raw).decode("ascii")

    def preprocess(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise BezoptInputError("request body must be an object")
        width = _integer(payload.get("width"), "width", 1, 2**31 - 1)
        height = _integer(payload.get("height"), "height", 1, 2**31 - 1)
        pixels = width * height
        if pixels > MAX_RASTER_PIXELS:
            raise BezoptInputError("raster pixel limit exceeded")
        rgb = self._decode_base64(payload.get("rgb_base64"), "rgb_base64")
        if len(rgb) != pixels * 3:
            raise BezoptInputError("rgb_base64 has the wrong byte length")
        color_space_name = payload.get("color_space", "rgb")
        if color_space_name not in _PREPROCESS_COLOR_SPACES:
            raise BezoptInputError("color_space is unknown")
        rgb_buffer = (ctypes.c_uint8 * len(rgb)).from_buffer_copy(rgb)
        label_buffer = self._label_buffer(payload.get("initial_labels_base64"), pixels)
        if label_buffer is None and payload.get("initial_region_count", 0) != 0:
            raise BezoptInputError("initial_region_count requires initial labels")
        initial_region_count = _integer(
            payload.get("initial_region_count", 0),
            "initial_region_count",
            0,
            2**32 - 1,
        )
        label_pointer = (
            ctypes.cast(label_buffer, ctypes.POINTER(ctypes.c_uint32))
            if label_buffer is not None
            else ctypes.POINTER(ctypes.c_uint32)()
        )
        view = CRgb8View(
            ctypes.cast(rgb_buffer, ctypes.POINTER(ctypes.c_uint8)),
            width,
            height,
            width * 3,
            _PREPROCESS_COLOR_SPACES[color_space_name],
            label_pointer,
            width if label_buffer is not None else 0,
            initial_region_count,
        )
        options = self._preprocess_options(payload.get("options"))
        result = CPreprocessResult()
        status = int(
            self._library.bezopt_preprocess_rgb8(
                ctypes.byref(view),
                ctypes.byref(options),
                ctypes.byref(result),
            )
        )
        try:
            status_bytes = self._library.bezopt_preprocess_status_string(status)
            status_text = status_bytes.decode("utf-8") if status_bytes else "unknown"
            if status != 0:
                raise BezoptInputError(f"native preprocessor returned {status_text}")
            channels = int(result.channels)
            regions = []
            for index in range(result.region_count):
                region = result.regions[index]
                mean_offset = index * channels
                regions.append(
                    {
                        "id": int(region.id),
                        "source_id": int(region.source_id),
                        "pixel_count": int(region.pixel_count),
                        "perimeter": float(region.perimeter),
                        "centroid": [float(region.centroid_x), float(region.centroid_y)],
                        "touches_border": bool(region.touches_border),
                        "mean_color": [
                            float(result.mean_colors[mean_offset + channel])
                            for channel in range(channels)
                        ],
                    }
                )
            edges = [
                {
                    "left": int(result.edges[index].left),
                    "right": int(result.edges[index].right),
                    "shared_boundary": float(result.edges[index].shared_boundary),
                    "protected_boundary": float(result.edges[index].protected_boundary),
                    "locked_raster_edges": int(result.edges[index].locked_raster_edges),
                }
                for index in range(result.edge_count)
            ]
            return {
                "width": int(result.width),
                "height": int(result.height),
                "labels_base64": self._labels_base64(result.labels, int(result.label_count)),
                "regions": regions,
                "edges": edges,
                "report": {
                    "status": int(result.status),
                    "status_text": status_text,
                    "initial_regions": int(result.initial_regions),
                    "final_regions": int(result.final_regions),
                    "rag_edges": int(result.edge_count),
                    "merges": int(result.merge_count),
                    "lambda_star": float(result.lambda_star),
                    "elapsed_ms": float(result.elapsed_ms),
                    "target_reached": bool(result.target_reached),
                },
            }
        finally:
            self._library.bezopt_free_preprocess_result(ctypes.byref(result))

    def fit(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise BezoptInputError("request body must be an object")
        width = _integer(payload.get("width"), "width", 1, 2**31 - 1)
        height = _integer(payload.get("height"), "height", 1, 2**31 - 1)
        pixels = width * height
        if pixels > MAX_RASTER_PIXELS:
            raise BezoptInputError("raster pixel limit exceeded")
        label_buffer = self._label_buffer(
            payload.get("labels_base64"), pixels, "labels_base64"
        )
        if label_buffer is None:
            raise BezoptInputError("labels_base64 is required")
        region_count = _integer(
            payload.get("region_count"), "region_count", 1, 2**32 - 1
        )

        colors_input = payload.get("region_linear_rgb")
        color_buffer: Any = None
        color_pointer = ctypes.POINTER(ctypes.c_double)()
        if colors_input is not None:
            if not isinstance(colors_input, list) or len(colors_input) != region_count * 3:
                raise BezoptInputError(
                    "region_linear_rgb must contain three values per region"
                )
            colors = [
                _finite_number(value, f"region_linear_rgb[{index}]")
                for index, value in enumerate(colors_input)
            ]
            if any(value < 0.0 or value > 1.0 for value in colors):
                raise BezoptInputError("region_linear_rgb values must be in [0,1]")
            color_buffer = (ctypes.c_double * len(colors))(*colors)
            color_pointer = ctypes.cast(color_buffer, ctypes.POINTER(ctypes.c_double))

        rgb_buffer: Any = None
        rgb_pointer = ctypes.POINTER(ctypes.c_uint8)()
        rgb_input = payload.get("rgb_base64")
        if rgb_input is not None:
            rgb = self._decode_base64(rgb_input, "rgb_base64")
            if len(rgb) != pixels * 3:
                raise BezoptInputError("rgb_base64 has the wrong byte length")
            rgb_buffer = (ctypes.c_uint8 * len(rgb)).from_buffer_copy(rgb)
            rgb_pointer = ctypes.cast(rgb_buffer, ctypes.POINTER(ctypes.c_uint8))

        view = CLabelRasterView(
            ctypes.cast(label_buffer, ctypes.POINTER(ctypes.c_uint32)),
            width,
            height,
            width,
            region_count,
            color_pointer,
            3 if color_buffer is not None else 0,
            rgb_pointer,
            width * 3 if rgb_buffer is not None else 0,
        )
        options = self._fit_options(payload.get("options"))
        result = CFitResult()
        status = int(
            self._library.bezopt_fit_boundaries(
                ctypes.byref(view), ctypes.byref(options), ctypes.byref(result)
            )
        )
        try:
            status_bytes = self._library.bezopt_fit_status_string(status)
            status_text = status_bytes.decode("utf-8") if status_bytes else "unknown"
            if status != 0:
                raise BezoptInputError(f"native fitter returned {status_text}")
            if result.chain_count > MAX_CHAINS:
                raise BezoptInputError("fitted chain limit exceeded")
            if result.control_point_count > MAX_CONTROL_POINTS:
                raise BezoptInputError("fitted control-point limit exceeded")
            if result.sample_count > MAX_SAMPLES:
                raise BezoptInputError("fitted sample limit exceeded")
            if result.source_point_count > MAX_SOURCE_POINTS:
                raise BezoptInputError("fitted source-point limit exceeded")

            chains = []
            for chain_index in range(result.chain_count):
                descriptor = result.chains[chain_index]
                control_offset = int(descriptor.control_point_offset)
                sample_offset = int(descriptor.sample_offset)
                source_offset = int(descriptor.source_point_offset)
                corner_offset = int(descriptor.corner_knot_offset)
                controls = [
                    [
                        float(result.control_xy[2 * (control_offset + point)]),
                        float(result.control_xy[2 * (control_offset + point) + 1]),
                    ]
                    for point in range(descriptor.control_point_count)
                ]
                samples = []
                for sample_index in range(descriptor.sample_count):
                    sample = result.samples[sample_offset + sample_index]
                    samples.append(
                        {
                            "segment": int(sample.segment),
                            "t": float(sample.t),
                            "point": [float(sample.x), float(sample.y)],
                            "normal": [float(sample.nx), float(sample.ny)],
                            "weight": float(sample.weight),
                        }
                    )
                source_points = [
                    [
                        float(result.source_xy[2 * (source_offset + point)]),
                        float(result.source_xy[2 * (source_offset + point) + 1]),
                    ]
                    for point in range(descriptor.source_point_count)
                ]
                corner_knots = [
                    int(result.corner_knots[corner_offset + knot])
                    for knot in range(descriptor.corner_knot_count)
                ]
                chains.append(
                    {
                        "control_points": controls,
                        "samples": samples,
                        "source_points": source_points,
                        "corner_knots": corner_knots,
                        "left_region": int(descriptor.left_region),
                        "right_region": int(descriptor.right_region),
                        "closed": bool(descriptor.closed),
                    }
                )
            report = result.report
            return {
                "chains": chains,
                "target_diagnostics": _target_correspondence_diagnostics(chains),
                "report": {
                    "status": int(report.status),
                    "status_text": status_text,
                    "raster_boundary_edges": int(report.raster_boundary_edges),
                    "raw_vertices": int(report.raw_vertices),
                    "pinned_vertices": int(report.pinned_vertices),
                    "open_chains": int(report.open_chains),
                    "closed_chains": int(report.closed_chains),
                    "cubics": int(report.cubics),
                    "target_samples": int(report.target_samples),
                    "topology_refits": int(report.topology_refits),
                    "recovered_chains": int(report.recovered_chains),
                    "grid_fallback_cubics": int(report.grid_fallback_cubics),
                    "unconstrained_cubics": int(report.unconstrained_cubics),
                    "curve_to_contour_px": float(report.curve_to_contour_px),
                    "max_curve_to_contour_px": float(
                        report.max_curve_to_contour_px),
                    "contour_to_curve_px": float(report.contour_to_curve_px),
                    "unconstrained_length_px": float(
                        report.unconstrained_length_px),
                    "grid_fallback_length_px": float(
                        report.grid_fallback_length_px),
                    "grid_fallback_chains": int(
                        report.grid_fallback_chains
                    ),
                    "accepted_error_px": float(report.accepted_error_px),
                    "prepare_ms": float(report.prepare_ms),
                    "trace_ms": float(report.trace_ms),
                    "fit_ms": float(report.fit_ms),
                    "elapsed_ms": float(report.elapsed_ms),
                    "used_grid_fallback": bool(report.used_grid_fallback),
                    "subpixel_edges": int(report.subpixel_edges),
                    "mean_abs_subpixel_offset_px": float(
                        report.mean_abs_subpixel_offset_px
                    ),
                    "mean_edge_confidence": float(report.mean_edge_confidence),
                    "max_abs_subpixel_offset_px": float(
                        report.max_abs_subpixel_offset_px
                    ),
                    "detected_corners": int(report.detected_corners),
                    "smoothed_guide_vertices": int(
                        report.smoothed_guide_vertices
                    ),
                    "mean_guide_displacement_px": float(
                        report.mean_guide_displacement_px
                    ),
                    "max_guide_displacement_px": float(
                        report.max_guide_displacement_px
                    ),
                },
            }
        finally:
            self._library.bezopt_free_fit_result(ctypes.byref(result))

    def render_reference(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise BezoptInputError("request body must be an object")
        width = _integer(payload.get("width"), "width", 1, 2**31 - 1)
        height = _integer(payload.get("height"), "height", 1, 2**31 - 1)
        pixels = width * height
        if pixels > MAX_RASTER_PIXELS:
            raise BezoptInputError("raster pixel limit exceeded")
        label_buffer = self._label_buffer(
            payload.get("labels_base64"), pixels, "labels_base64"
        )
        if label_buffer is None:
            raise BezoptInputError("labels_base64 is required")
        region_count = _integer(
            payload.get("region_count"), "region_count", 1, 2**32 - 1
        )
        colors_input = payload.get("region_linear_rgb")
        if not isinstance(colors_input, list) or len(colors_input) != region_count * 3:
            raise BezoptInputError(
                "region_linear_rgb must contain three values per region"
            )
        colors = [
            _finite_number(value, f"region_linear_rgb[{index}]")
            for index, value in enumerate(colors_input)
        ]
        if any(value < 0.0 or value > 1.0 for value in colors):
            raise BezoptInputError("region_linear_rgb values must be in [0,1]")
        color_buffer = (ctypes.c_double * len(colors))(*colors)

        source_buffer: Any = None
        source_pointer = ctypes.POINTER(ctypes.c_uint8)()
        source_input = payload.get("rgb_base64")
        if source_input is not None:
            source = self._decode_base64(source_input, "rgb_base64")
            if len(source) != pixels * 3:
                raise BezoptInputError("rgb_base64 has the wrong byte length")
            source_buffer = (ctypes.c_uint8 * len(source)).from_buffer_copy(source)
            source_pointer = ctypes.cast(
                source_buffer, ctypes.POINTER(ctypes.c_uint8)
            )

        chains_input = payload.get("chains")
        if not isinstance(chains_input, list):
            raise BezoptInputError("chains must be an array")
        if len(chains_input) > MAX_CHAINS:
            raise BezoptInputError("chain limit exceeded")
        control_buffers: list[Any] = []
        native_chains: list[CChain] = []
        total_controls = 0
        for chain_index, chain_input in enumerate(chains_input):
            label = f"chains[{chain_index}]"
            if not isinstance(chain_input, dict):
                raise BezoptInputError(f"{label} must be an object")
            points_input = chain_input.get("control_points")
            if not isinstance(points_input, list) or not points_input:
                raise BezoptInputError(
                    f"{label}.control_points must be a non-empty array"
                )
            flattened: list[float] = []
            for point_index, point in enumerate(points_input):
                x, y = _pair(point, f"{label}.control_points[{point_index}]")
                flattened.extend((x, y))
            total_controls += len(points_input)
            if total_controls > MAX_CONTROL_POINTS:
                raise BezoptInputError("control-point limit exceeded")
            control_buffer = (ctypes.c_double * len(flattened))(*flattened)
            first = _integer(
                chain_input.get("left_region"),
                f"{label}.left_region",
                0,
                region_count - 1,
            )
            second = _integer(
                chain_input.get("right_region"),
                f"{label}.right_region",
                0,
                region_count - 1,
            )
            closed = chain_input.get("closed", False)
            if not isinstance(closed, bool):
                raise BezoptInputError(f"{label}.closed must be boolean")
            native_chains.append(
                CChain(
                    ctypes.cast(control_buffer, ctypes.POINTER(ctypes.c_double)),
                    len(points_input),
                    ctypes.POINTER(CSample)(),
                    0,
                    first,
                    second,
                    int(closed),
                )
            )
            control_buffers.append(control_buffer)

        chain_buffer = (CChain * len(native_chains))(*native_chains)
        view = CRasterView(
            ctypes.cast(label_buffer, ctypes.POINTER(ctypes.c_uint32)),
            width,
            height,
            width,
            region_count,
            ctypes.cast(color_buffer, ctypes.POINTER(ctypes.c_double)),
            3,
            source_pointer,
            width * 3 if source_buffer is not None else 0,
            ctypes.POINTER(ctypes.c_double)(),
            0,
        )
        options = self._raster_options(payload.get("options"))
        result = CRasterResult()
        status = int(
            self._library.bezopt_render_reference(
                chain_buffer,
                len(native_chains),
                ctypes.byref(view),
                ctypes.byref(options),
                ctypes.byref(result),
            )
        )
        try:
            status_bytes = self._library.bezopt_raster_status_string(status)
            status_text = status_bytes.decode("utf-8") if status_bytes else "unknown"
            if status != 0:
                # The report is already filled in on a refusal, and how many
                # scanline samples failed is the difference between a network
                # the rasterizer genuinely cannot replay and one that trips it
                # in a handful of places. Carry that count into the message.
                raise BezoptInputError(
                    f"native rasterizer returned {status_text}"
                    f" ({int(result.report.transition_errors)} of"
                    f" {int(result.report.crossings)} crossings inconsistent)"
                )
            expected_size = pixels * 3
            if result.srgb8_size != expected_size or not result.srgb8:
                raise RuntimeError("native rasterizer returned an invalid image buffer")
            raw = ctypes.string_at(result.srgb8, result.srgb8_size)
            report = result.report
            psnr = float(report.psnr_db)
            return {
                "width": width,
                "height": height,
                "rgb_base64": base64.b64encode(raw).decode("ascii"),
                "report": {
                    "status": int(report.status),
                    "status_text": status_text,
                    "subpixel_samples": int(report.subpixel_samples),
                    "cubic_tests": int(report.cubic_tests),
                    "crossings": int(report.crossings),
                    "transition_errors": int(report.transition_errors),
                    "bands": int(report.bands),
                    "initial_length_px": float(report.initial_length_px),
                    "squared_error": float(report.squared_error),
                    "yang_data_energy": float(report.yang_data_energy),
                    "mse": float(report.mse),
                    "psnr_db": psnr if math.isfinite(psnr) else None,
                    "index_ms": float(report.index_ms),
                    "render_ms": float(report.render_ms),
                    "elapsed_ms": float(report.elapsed_ms),
                },
            }
        finally:
            self._library.bezopt_free_raster_result(ctypes.byref(result))

    def export_flat_svg(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise BezoptInputError("request body must be an object")
        width = _integer(payload.get("width"), "width", 1, 2**31 - 1)
        height = _integer(payload.get("height"), "height", 1, 2**31 - 1)
        region_count = _integer(
            payload.get("region_count"), "region_count", 1, 2**32 - 1
        )
        colors_input = payload.get("region_linear_rgb")
        if not isinstance(colors_input, list) or len(colors_input) != region_count * 3:
            raise BezoptInputError(
                "region_linear_rgb must contain three values per region"
            )
        colors = [
            _finite_number(value, f"region_linear_rgb[{index}]")
            for index, value in enumerate(colors_input)
        ]
        if any(value < 0.0 or value > 1.0 for value in colors):
            raise BezoptInputError("region_linear_rgb values must be in [0,1]")
        color_buffer = (ctypes.c_double * len(colors))(*colors)

        # Optional per-region segmentation metadata: whether each region
        # touches the image frame (one 0/1/boolean value per region). Lets
        # the native exporter synthesize the frame rectangle as the outer
        # contour for frame-covering regions whose fitted boundaries are all
        # interior closed chains. Omitted -> NULL -> legacy behavior.
        touches_input = payload.get("region_touches_frame")
        touches_buffer: Any = None
        touches_ptr: Any = None
        if touches_input is not None:
            if (
                not isinstance(touches_input, list)
                or len(touches_input) != region_count
            ):
                raise BezoptInputError(
                    "region_touches_frame must contain one value per region"
                )
            touches: list[int] = []
            for index, value in enumerate(touches_input):
                if isinstance(value, bool):
                    touches.append(1 if value else 0)
                elif isinstance(value, int) and value in (0, 1):
                    touches.append(value)
                else:
                    raise BezoptInputError(
                        f"region_touches_frame[{index}] must be 0, 1, or boolean"
                    )
            touches_buffer = (ctypes.c_uint8 * region_count)(*touches)
            touches_ptr = ctypes.cast(
                touches_buffer, ctypes.POINTER(ctypes.c_uint8)
            )

        chains_input = payload.get("chains")
        if not isinstance(chains_input, list) or not chains_input:
            raise BezoptInputError("chains must be a non-empty array")
        if len(chains_input) > MAX_CHAINS:
            raise BezoptInputError("chain limit exceeded")
        control_buffers: list[Any] = []
        native_chains: list[CChain] = []
        total_controls = 0
        for chain_index, chain_input in enumerate(chains_input):
            label = f"chains[{chain_index}]"
            if not isinstance(chain_input, dict):
                raise BezoptInputError(f"{label} must be an object")
            points_input = chain_input.get("control_points")
            if not isinstance(points_input, list) or not points_input:
                raise BezoptInputError(
                    f"{label}.control_points must be a non-empty array"
                )
            flattened: list[float] = []
            for point_index, point in enumerate(points_input):
                x, y = _pair(point, f"{label}.control_points[{point_index}]")
                flattened.extend((x, y))
            total_controls += len(points_input)
            if total_controls > MAX_CONTROL_POINTS:
                raise BezoptInputError("control-point limit exceeded")
            control_buffer = (ctypes.c_double * len(flattened))(*flattened)
            first = _integer(
                chain_input.get("left_region"),
                f"{label}.left_region",
                0,
                region_count - 1,
            )
            second = _integer(
                chain_input.get("right_region"),
                f"{label}.right_region",
                0,
                region_count - 1,
            )
            closed = chain_input.get("closed", False)
            if not isinstance(closed, bool):
                raise BezoptInputError(f"{label}.closed must be boolean")
            native_chains.append(
                CChain(
                    ctypes.cast(control_buffer, ctypes.POINTER(ctypes.c_double)),
                    len(points_input),
                    ctypes.POINTER(CSample)(),
                    0,
                    first,
                    second,
                    int(closed),
                )
            )
            control_buffers.append(control_buffer)

        chain_buffer = (CChain * len(native_chains))(*native_chains)
        view = CSvgView(
            width,
            height,
            region_count,
            ctypes.cast(color_buffer, ctypes.POINTER(ctypes.c_double)),
            3,
            touches_ptr,
        )
        result = CSvgResult()
        status = int(
            self._library.bezopt_export_flat_svg(
                chain_buffer,
                len(native_chains),
                ctypes.byref(view),
                ctypes.byref(result),
            )
        )
        try:
            status_text = self._library.bezopt_raster_status_string(status).decode(
                "utf-8"
            )
            if status != 0:
                raise BezoptInputError(f"native svg exporter returned {status_text}")
            if not result.svg_utf8 or result.svg_utf8_size == 0:
                raise RuntimeError("native svg exporter returned an empty document")
            svg_text = ctypes.string_at(result.svg_utf8, result.svg_utf8_size).decode(
                "utf-8"
            )
            report = result.report
            return {
                "width": width,
                "height": height,
                "svg": svg_text,
                "report": {
                    "status": int(report.status),
                    "status_text": status_text,
                    "region_count": int(report.region_count),
                    "loop_count": int(report.loop_count),
                    "path_count": int(report.path_count),
                    "elapsed_ms": float(report.elapsed_ms),
                },
            }
        finally:
            self._library.bezopt_free_svg_result(ctypes.byref(result))

    def optimize_raster(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise BezoptInputError("request body must be an object")
        width = _integer(payload.get("width"), "width", 1, 2**31 - 1)
        height = _integer(payload.get("height"), "height", 1, 2**31 - 1)
        pixels = width * height
        if pixels > MAX_RASTER_PIXELS:
            raise BezoptInputError("raster pixel limit exceeded")
        label_buffer = self._label_buffer(
            payload.get("labels_base64"), pixels, "labels_base64"
        )
        if label_buffer is None:
            raise BezoptInputError("labels_base64 is required")
        region_count = _integer(
            payload.get("region_count"), "region_count", 1, 2**32 - 1
        )
        colors_input = payload.get("region_linear_rgb")
        if not isinstance(colors_input, list) or len(colors_input) != region_count * 3:
            raise BezoptInputError(
                "region_linear_rgb must contain three values per region"
            )
        colors = [
            _finite_number(value, f"region_linear_rgb[{index}]")
            for index, value in enumerate(colors_input)
        ]
        if any(value < 0.0 or value > 1.0 for value in colors):
            raise BezoptInputError("region_linear_rgb values must be in [0,1]")
        color_buffer = (ctypes.c_double * len(colors))(*colors)
        source = self._decode_base64(payload.get("rgb_base64"), "rgb_base64")
        if len(source) != pixels * 3:
            raise BezoptInputError("rgb_base64 has the wrong byte length")
        source_buffer = (ctypes.c_uint8 * len(source)).from_buffer_copy(source)

        chains_input = payload.get("chains")
        if not isinstance(chains_input, list) or not chains_input:
            raise BezoptInputError("chains must be a non-empty array")
        if len(chains_input) > MAX_CHAINS:
            raise BezoptInputError("chain limit exceeded")
        control_buffers: list[Any] = []
        sample_buffers: list[Any] = []
        native_chains: list[CChain] = []
        total_controls = 0
        total_samples = 0
        for chain_index, chain_input in enumerate(chains_input):
            label = f"chains[{chain_index}]"
            if not isinstance(chain_input, dict):
                raise BezoptInputError(f"{label} must be an object")
            points_input = chain_input.get("control_points")
            if not isinstance(points_input, list) or not points_input:
                raise BezoptInputError(
                    f"{label}.control_points must be a non-empty array"
                )
            flattened: list[float] = []
            for point_index, point in enumerate(points_input):
                x, y = _pair(point, f"{label}.control_points[{point_index}]")
                flattened.extend((x, y))
            total_controls += len(points_input)
            if total_controls > MAX_CONTROL_POINTS:
                raise BezoptInputError("control-point limit exceeded")
            control_buffer = (ctypes.c_double * len(flattened))(*flattened)

            samples_input = chain_input.get("samples", [])
            if not isinstance(samples_input, list):
                raise BezoptInputError(f"{label}.samples must be an array")
            samples: list[CSample] = []
            for sample_index, sample_input in enumerate(samples_input):
                sample_label = f"{label}.samples[{sample_index}]"
                if not isinstance(sample_input, dict):
                    raise BezoptInputError(f"{sample_label} must be an object")
                segment = _integer(
                    sample_input.get("segment"),
                    f"{sample_label}.segment",
                    0,
                    2**32 - 1,
                )
                t = _finite_number(sample_input.get("t"), f"{sample_label}.t")
                x, y = _pair(sample_input.get("point"), f"{sample_label}.point")
                nx, ny = _pair(
                    sample_input.get("normal"), f"{sample_label}.normal"
                )
                weight = _finite_number(
                    sample_input.get("weight", 1.0), f"{sample_label}.weight"
                )
                samples.append(CSample(segment, t, x, y, nx, ny, weight))
            total_samples += len(samples)
            if total_samples > MAX_SAMPLES:
                raise BezoptInputError("sample limit exceeded")
            sample_buffer = (CSample * len(samples))(*samples)
            sample_pointer = (
                ctypes.cast(sample_buffer, ctypes.POINTER(CSample))
                if samples
                else ctypes.POINTER(CSample)()
            )
            first = _integer(
                chain_input.get("left_region"),
                f"{label}.left_region",
                0,
                region_count - 1,
            )
            second = _integer(
                chain_input.get("right_region"),
                f"{label}.right_region",
                0,
                region_count - 1,
            )
            closed = chain_input.get("closed", False)
            if not isinstance(closed, bool):
                raise BezoptInputError(f"{label}.closed must be boolean")
            native_chains.append(
                CChain(
                    ctypes.cast(control_buffer, ctypes.POINTER(ctypes.c_double)),
                    len(points_input),
                    sample_pointer,
                    len(samples),
                    first,
                    second,
                    int(closed),
                )
            )
            control_buffers.append(control_buffer)
            sample_buffers.append(sample_buffer)

        chain_buffer = (CChain * len(native_chains))(*native_chains)
        view = CRasterView(
            ctypes.cast(label_buffer, ctypes.POINTER(ctypes.c_uint32)),
            width,
            height,
            width,
            region_count,
            ctypes.cast(color_buffer, ctypes.POINTER(ctypes.c_double)),
            3,
            ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_uint8)),
            width * 3,
            ctypes.cast(color_buffer, ctypes.POINTER(ctypes.c_double)),
            3,
        )
        options = self._raster_optimize_options(payload.get("options"))
        report = CRasterOptimizeReport()
        status = int(
            self._library.bezopt_optimize_raster(
                chain_buffer,
                len(native_chains),
                ctypes.byref(view),
                ctypes.byref(options),
                ctypes.byref(report),
            )
        )
        status_bytes = self._library.bezopt_raster_status_string(status)
        status_text = status_bytes.decode("utf-8") if status_bytes else "unknown"
        if status != 0:
            raise BezoptInputError(f"native raster optimizer returned {status_text}")
        output_chains = []
        for chain_index, chain_input in enumerate(chains_input):
            control_buffer = control_buffers[chain_index]
            point_count = len(chain_input["control_points"])
            output_chains.append(
                {
                    "control_points": [
                        [
                            float(control_buffer[2 * point]),
                            float(control_buffer[2 * point + 1]),
                        ]
                        for point in range(point_count)
                    ]
                }
            )
        return {
            "chains": output_chains,
            "region_linear_rgb": [
                float(color_buffer[index]) for index in range(len(colors))
            ],
            "report": {
                "status": int(report.status),
                "status_text": status_text,
                "sweeps": int(report.sweeps),
                "line_search_evaluations": int(report.line_search_evaluations),
                "topology_rejections": int(report.topology_rejections),
                "active_pixels": int(report.active_pixels),
                "subpixel_samples": int(report.subpixel_samples),
                "cubic_tests": int(report.cubic_tests),
                "gradient_intervals": int(report.gradient_intervals),
                "geometry_blocks": int(report.geometry_blocks),
                "geometry_batches": int(report.geometry_batches),
                "block_solve_fallbacks": int(report.block_solve_fallbacks),
                "initial_length_px": float(report.initial_length_px),
                "initial_active_squared_error": float(
                    report.initial_active_squared_error
                ),
                "final_active_squared_error": float(
                    report.final_active_squared_error
                ),
                "initial_data_energy": float(report.initial_data_energy),
                "final_data_energy": float(report.final_data_energy),
                "initial_prior_energy": float(report.initial_prior_energy),
                "final_prior_energy": float(report.final_prior_energy),
                "initial_objective": float(report.initial_objective),
                "final_objective": float(report.final_objective),
                "maximum_control_step_px": float(report.maximum_control_step_px),
                "color_solves": int(report.color_solves),
                "color_solve_iterations": int(report.color_solve_iterations),
                "initial_full_squared_error": float(
                    report.initial_full_squared_error
                ),
                "final_full_squared_error": float(report.final_full_squared_error),
                "initial_full_data_energy": float(report.initial_full_data_energy),
                "final_full_data_energy": float(report.final_full_data_energy),
                "maximum_color_change": float(report.maximum_color_change),
                "elapsed_ms": float(report.elapsed_ms),
                "converged": bool(report.converged),
            },
            "problem_size": {
                "chains": len(chains_input),
                "control_points": total_controls,
                "samples": total_samples,
                "active_pixels": int(report.active_pixels),
            },
        }

    def optimize(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise BezoptInputError("request body must be an object")
        chains_input = payload.get("chains")
        if not isinstance(chains_input, list) or not chains_input:
            raise BezoptInputError("chains must be a non-empty array")
        if len(chains_input) > MAX_CHAINS:
            raise BezoptInputError("chain limit exceeded")

        control_buffers: list[Any] = []
        sample_buffers: list[Any] = []
        corner_buffers: list[Any] = []
        native_chains: list[CChain] = []
        total_controls = 0
        total_samples = 0

        for chain_index, chain_input in enumerate(chains_input):
            label = f"chains[{chain_index}]"
            if not isinstance(chain_input, dict):
                raise BezoptInputError(f"{label} must be an object")
            points_input = chain_input.get("control_points")
            if not isinstance(points_input, list) or not points_input:
                raise BezoptInputError(f"{label}.control_points must be a non-empty array")
            flattened: list[float] = []
            for point_index, point in enumerate(points_input):
                x, y = _pair(point, f"{label}.control_points[{point_index}]")
                flattened.extend((x, y))
            total_controls += len(points_input)
            if total_controls > MAX_CONTROL_POINTS:
                raise BezoptInputError("control-point limit exceeded")
            control_buffer = (ctypes.c_double * len(flattened))(*flattened)

            samples_input = chain_input.get("samples", [])
            if not isinstance(samples_input, list):
                raise BezoptInputError(f"{label}.samples must be an array")
            samples: list[CSample] = []
            for sample_index, sample_input in enumerate(samples_input):
                sample_label = f"{label}.samples[{sample_index}]"
                if not isinstance(sample_input, dict):
                    raise BezoptInputError(f"{sample_label} must be an object")
                segment = _integer(
                    sample_input.get("segment"),
                    f"{sample_label}.segment",
                    0,
                    2**32 - 1,
                )
                t = _finite_number(sample_input.get("t"), f"{sample_label}.t")
                x, y = _pair(sample_input.get("point"), f"{sample_label}.point")
                nx, ny = _pair(sample_input.get("normal"), f"{sample_label}.normal")
                weight = _finite_number(sample_input.get("weight", 1.0), f"{sample_label}.weight")
                samples.append(CSample(segment, t, x, y, nx, ny, weight))
            total_samples += len(samples)
            if total_samples > MAX_SAMPLES:
                raise BezoptInputError("sample limit exceeded")
            sample_buffer = (CSample * len(samples))(*samples)

            left_region = _integer(
                chain_input.get("left_region", 0),
                f"{label}.left_region",
                0,
                2**32 - 1,
            )
            right_region = _integer(
                chain_input.get("right_region", 0),
                f"{label}.right_region",
                0,
                2**32 - 1,
            )
            closed = chain_input.get("closed", False)
            if not isinstance(closed, bool):
                raise BezoptInputError(f"{label}.closed must be boolean")
            sample_pointer = (
                ctypes.cast(sample_buffer, ctypes.POINTER(CSample))
                if samples
                else ctypes.POINTER(CSample)()
            )
            # Cubic count, so the knot index the fitter reports stays in range.
            segment_count = (
                len(points_input) // 3 if closed else (len(points_input) - 1) // 3
            )
            corner_input = chain_input.get("corner_knots", [])
            if not isinstance(corner_input, (list, tuple)):
                raise BezoptInputError(f"{label}.corner_knots must be a list")
            corners = [
                _integer(
                    value,
                    f"{label}.corner_knots[{index}]",
                    0,
                    max(segment_count - 1, 0),
                )
                for index, value in enumerate(corner_input)
            ]
            corner_buffer = (ctypes.c_uint32 * len(corners))(*corners)
            corner_pointer = (
                ctypes.cast(corner_buffer, ctypes.POINTER(ctypes.c_uint32))
                if corners
                else ctypes.POINTER(ctypes.c_uint32)()
            )
            native_chains.append(
                CChain(
                    ctypes.cast(control_buffer, ctypes.POINTER(ctypes.c_double)),
                    len(points_input),
                    sample_pointer,
                    len(samples),
                    left_region,
                    right_region,
                    int(closed),
                    corner_pointer,
                    len(corners),
                )
            )
            control_buffers.append(control_buffer)
            sample_buffers.append(sample_buffer)
            corner_buffers.append(corner_buffer)

        chain_buffer = (CChain * len(native_chains))(*native_chains)
        options = self._options(payload.get("options"))
        report = CReport()
        status = int(
            self._library.bezopt_optimize(
                chain_buffer,
                len(native_chains),
                ctypes.byref(options),
                ctypes.byref(report),
            )
        )
        status_bytes = self._library.bezopt_status_string(status)
        status_text = status_bytes.decode("utf-8") if status_bytes else "unknown"

        output_chains = []
        for chain_index, chain_input in enumerate(chains_input):
            control_buffer = control_buffers[chain_index]
            point_count = len(chain_input["control_points"])
            output_chains.append(
                {
                    "control_points": [
                        [control_buffer[2 * point], control_buffer[2 * point + 1]]
                        for point in range(point_count)
                    ]
                }
            )

        return {
            "chains": output_chains,
            "report": {
                "status": int(report.status),
                "status_text": status_text,
                "sweeps": int(report.sweeps),
                "blocks_optimized": int(report.blocks_optimized),
                "function_evaluations": int(report.function_evaluations),
                "sample_evaluations": int(report.sample_evaluations),
                "topology_rejections": int(report.topology_rejections),
                "initial_energy": float(report.initial_energy),
                "final_energy": float(report.final_energy),
                "initial_normal_rmse_px": float(report.initial_normal_rmse_px),
                "final_normal_rmse_px": float(report.final_normal_rmse_px),
                "elapsed_ms": float(report.elapsed_ms),
                "converged": bool(report.converged),
            },
            "problem_size": {
                "chains": len(chains_input),
                "control_points": total_controls,
                "samples": total_samples,
            },
        }
