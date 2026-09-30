"use strict";

const $ = (id) => document.getElementById(id);

const canvas = $("boundary-canvas");
const context = canvas.getContext("2d");
const MAX_DIAGNOSTIC_RASTER_PIXELS = 4_000_000;
const MAX_LABEL_BOUNDARY_SEGMENTS = 500_000;
// Existing quality tuning was done at or below a 512x512 working area. Keep
// that behavior for small inputs and scale all dimensional solver controls
// together above it. This never resizes or otherwise changes the raster.
const REFERENCE_OPTIMIZATION_PIXELS = 512 * 512;

const state = {
  inputMode: "fixture",
  preview: "fixture",
  sessions: { fixture: null, raster: null },
  problem: null,
  baseline: null,
  optimized: null,
  report: null,
  response: null,
  preset: "wave",
  running: false,
  hover: null,
  drag: null,
  view: { scale: 1, offsetX: 0, offsetY: 0 },
  canvasWidth: 1,
  canvasHeight: 1,
  overlayImage: null,
  overlayUrl: null,
  overlayName: null,
  discrete: null,
  reference: null,
  svgPreview: null,
  rasterReport: null,
  preprocessing: false,
  fitting: false,
  rendering: false,
  exportingSvg: false,
  liveRebuild: false,
  suppressLiveRebuild: false,
  liveRebuildTimer: null,
  liveRebuildPendingStage: null,
  liveRebuildRunning: false,
  nativeDefaults: null,
};

const rasterPreviewOrder = [
  "source",
  "regions",
  "boundaries",
  "rag",
  "initial",
  "initial-fill",
  "optimized",
  "optimized-fill",
  "flat-svg",
];

const descriptions = {
  wave: "Four cubics offset from a smooth target; drag any handle before optimizing.",
  junction: "Three shared interfaces meet at one pinned primal-graph junction.",
  ring: "A closed four-cubic boundary exercises wraparound blocks and topology.",
  crossing: "Two interfaces cross away from a junction and must be rejected.",
  overlap: "Two chains leave the same junction along a shared span and must be rejected.",
  reversal: "A collinear cubic folds backward; adaptive flattening must expose it.",
  batch: "A 256-chain, 512-cubic synthetic throughput and scheduling workload.",
};

const parameterHelp = Object.freeze({
  "preset-select": {
    what: "Selects a deterministic optimizer fixture and replaces the current test-case geometry.",
    how: "Each case supplies shared cubic controls, target points, normals, weights, and region IDs directly to the same native C API used by raster fits.",
    up: "Larger fixtures such as the 256-chain batch expose scheduling and throughput behavior.",
    down: "Small fixtures isolate geometry, topology, or one objective term and are easier to inspect.",
    performance: "Work follows chain, cubic, target, sweep, and local-iteration counts; the rejection fixtures usually stop before optimization.",
    note: "Fixture mode and raster mode are mutually exclusive in the preview. Switching modes preserves each mode's last session but never draws them together.",
  },
  "preprocess-target": {
    what: "Requests the final number of flat-color VBRM regions.",
    how: "The merger repeatedly combines eligible adjacent regions toward this budget; it cannot create regions absent from the initial partition.",
    up: "More regions retain weak edges, antialias bands, and small details, but can create many short boundary chains.",
    down: "Fewer regions simplify the graph and colors; too few merge letters, thin strokes, holes, or nearby materials into their surroundings.",
    performance: "Higher counts leave more RAG nodes and usually more chains, cubics, targets, optimizer blocks, and topology checks.",
    note: "The report shows the actual count. Use 16 for the Google Ads crop; choose a separate budget for other images. More regions do not guarantee better vector shapes.",
  },
  "preprocess-criterion": {
    what: "Chooses the VBRM merge-gain functional.",
    how: "Area, Beaulieu–Goldberg, Mumford–Shah, and Scale rank each adjacent-region merge from color moments, area, and shared-boundary statistics.",
    up: "Area is the practical default; MS and Scale emphasize model/geometry tradeoffs; BG is the paper baseline for color homogeneity.",
    down: "Changing the functional can reorder the entire merge history even with the same target count.",
    performance: "All use the same lazy heap. Cost differences are small compared with changes in the surviving graph and boundary complexity.",
    note: "Area exponent, smallness scale, and raster bias affect only the Area functional. Pair Area with OKLab for the logo-tuned lab defaults.",
  },
  "preprocess-color-space": {
    what: "Chooses the coordinates in which VBRM measures color differences.",
    how: "Packed sRGB is converted once to encoded sRGB, linear RGB, CIE Lab, or OKLab before region moments and merge costs are computed.",
    up: "Lab or OKLab can preserve perceptually distinct hue edges; linear RGB treats antialias values as physical coverage more closely.",
    down: "Encoded sRGB is predictable for digital fills but overweights gamma-space midtones relative to linear coverage.",
    performance: "Conversion is one linear raster pass; graph complexity after merging usually dominates any conversion difference.",
    note: "The lab Defaults button restores OKLab. Flat regions uses mean encoded sRGB. Later filled-RGB optimization can change colors. This setting changes merging, not the SVG color encoding.",
  },
  "preprocess-seed": {
    what: "Chooses the initial full-resolution discrete partition supplied to VBRM.",
    how: "Connected colors labels each four-connected run of identical source RGB; one-region-per-pixel starts with the full source pixel graph.",
    up: "Pixel seeds allow the merger to partition an initially uniform color component, at the cost of the largest graph.",
    down: "Connected-color seeds are dramatically smaller for segmented images and preserve every exact component before merging.",
    performance: "This is the largest preprocessor memory control. Pixel seeds scale with source pixels; component seeds scale with full-resolution connected color components.",
    note: "For a production segmented photo, pass the preprocessor's existing dense labels directly rather than recomputing either browser seed mode.",
  },
  "preprocess-iterations": {
    what: "Sets the number of deterministic dual merge phases.",
    how: "The requested merge work is split across repeated Algorithm 1 phases with lambda-star refinement.",
    up: "More phases can refine the stopping scale and merge ordering on difficult partitions.",
    down: "One phase is the fastest and is sufficient when geometry feedback is not part of the discrete port.",
    performance: "More phases add heap and bookkeeping work; they do not multiply the requested final region count.",
    note: "This port intentionally excludes the legacy VBRM primal/vector stage, so phase effects are smaller than in the full research application.",
  },
  "preprocess-area-exponent": {
    what: "Controls how strongly the Area criterion favors merging small regions.",
    how: "The Area gain raises the size-dependent factor to this positive exponent before ranking adjacent merges.",
    up: "Higher values more aggressively absorb small components and suppress speckle.",
    down: "Lower positive values make size less dominant and preserve more small regions.",
    performance: "Negligible cost per heap update; indirect cost can change substantially through the surviving boundary graph.",
    note: "Only applies when Criterion is Area. Values must be positive; negative exponents are invalid.",
  },
  "preprocess-smallness": {
    what: "Adds an Area-criterion scale for discounting very small regions.",
    how: "Region area is compared with this non-negative scale inside the Area merge multiplier.",
    up: "Higher values make tiny components easier to merge and can remove antialias fragments or noise.",
    down: "Zero disables the extension and preserves the base Area equation.",
    performance: "Constant work per changed edge; fewer surviving fragments can greatly reduce fit and optimization cost.",
    note: "Too high a value can erase intentional dots, counters, serifs, or narrow isolated regions.",
  },
  "preprocess-raster-bias": {
    what: "Biases Area merges using raster-boundary support.",
    how: "Discounts merge cost using smaller-region area and shared-boundary length. It does not read RGB edge strength or protection maps.",
    up: "Higher values strengthen the geometric discount, especially for small regions sharing long boundaries.",
    down: "Zero disables the extension and follows the unmodified Area ranking.",
    performance: "Constant work per changed edge; the resulting merge order can change downstream complexity.",
    note: "Only applies to Area. Inspect Flat regions for lost small features before fitting.",
  },
  "preprocess-downsample": {
    what: "Allow downsampling rasters that exceed the megapixel limit.",
    how: "When checked, oversized images are scaled down to fit the limit using high-quality canvas resampling. When unchecked, oversized images are rejected with an error.",
    up: "Checked lets large images through; the topology is computed on the downsampled raster and may differ from full resolution.",
    down: "Unchecked preserves the never-silently-downsample guarantee; use the native API for full-resolution large images.",
    performance: "Downsampling is a one-time canvas operation; smaller rasters are faster downstream.",
    note: "Explicit consent only — the UI never downsamples silently. A warning is shown when downsampling occurs.",
  },
  "preprocess-max-mp": {
    what: "Maximum raster size in megapixels before the limit applies.",
    how: "Images larger than this are either downsampled (if allowed) or rejected. Lower this for constrained backends (e.g. serverless payload limits).",
    up: "Higher values allow larger rasters; watch backend request-size limits.",
    down: "Lower values (e.g. 1.0) keep payloads small for serverless deployments.",
    performance: "Smaller limits mean smaller payloads and faster transfers.",
    note: "Default 4.0 matches the diagnostic limit; use 1.0 or lower on Vercel.",
  },
  "preprocess-saliency": {
    what: "Unavailable in this browser lab: changing this weight has no effect.",
    how: "The native merger can penalize protected boundaries, but the browser RGB input provides no protection map.",
    note: "This is not a general image-detail or edge-strength control.",
  },
  "preprocess-topology": {
    what: "Unavailable in this browser lab: changing this weight has no effect.",
    how: "The native isolation penalty is multiplied by boundary protection, which is zero without a protection map.",
    note: "This does not control the fitter or optimizer topology checks. Use Preserve topology under Shared settings.",
  },
  "vector-render-size": {
    what: "Sets the pixel size the vector source is rasterized to before anything else runs.",
    how: "The longest edge of the artboard becomes this many pixels and the other follows the aspect ratio. The result is composited onto white, then treated exactly like any other loaded raster.",
    up: "More pixels per shape, so the fitter has more evidence and geometric error falls. Cost and run time rise roughly with the pixel count.",
    down: "Fewer pixels, which is the harder problem and where defects show up first.",
    performance: "Quadratic in this value. Doubling it quadruples the pixels and roughly quadruples preprocessing time.",
    note: "Only appears for vector sources. A raster's resolution is data and is never resampled — that is why there is no equivalent control for PNG or JPEG. Sweeping this is the interactive form of the convergence test in bench/svg_roundtrip.py: recovery error should fall as it rises."
  },
  "fit-residual-sigmas": {
    what: "Controls how much average boundary error a cubic may have before it is split.",
    how: "Above zero, accepts RMS error up to this value / √12 source pixels. This uses a grid-quantization noise model, not a measured noise level for this image.",
    up: "Usually permits fewer cubics, but may lose small features.",
    down: "Usually adds cubics. Zero switches acceptance to the maximum Pixel error budget.",
    note: "With RMS enabled, isolated large errors can pass. Review Final SVG at fixed labels; this is not a guarantee of equal quality across images.",
  },
  "fit-error": {
    what: "Sets the maximum-error budget when RMS allowance is zero. With RMS enabled it still gates reparameterization.",
    how: "Converted from reference pixels by solver scale. A rejected candidate gets extra parameter-refinement attempts only when its maximum error is within four times this budget.",
    up: "Allows more parameter-refinement attempts; with RMS = 0, also permits looser fits.",
    down: "Narrows that gate; with RMS = 0, usually adds cubics.",
    note: "It is not a maximum-deviation guarantee under RMS acceptance, and does not directly set the final optimizer error.",
  },
  "fit-samples": {
    what: "Caps boundary-optimizer targets per fitted cubic. It does not change initial curve geometry.",
    how: "Bins raw edge targets while retaining represented length and evidence weight.",
    up: "Resolves more local target variation, with more optimizer work.",
    down: "Uses less memory and time, but can average away localized evidence.",
    note: "This is not raster samples per axis. Refit to regenerate targets, then optimize.",
  },
  "fit-reparameterization": {
    what: "Limits extra parameter-refinement attempts for a rejected cubic before splitting.",
    how: "Near-budget candidates update sample positions along the curve and solve handles again. Already accepted candidates skip this step.",
    up: "May rescue a candidate with fewer splits, at extra fitting cost.",
    down: "Zero skips these attempts.",
    note: "Gated by Pixel error even when RMS acceptance is enabled. Boundary-optimizer sample reprojection is separate.",
  },
  "fit-corner-angle": {
    what: "Sets the turn angle at which a raw chain is split into a C0 corner.",
    how: "The fitter averages local incoming/outgoing directions and compares their turn with this degree threshold.",
    up: "A higher threshold protects fewer corners and yields longer, smoother fitting spans.",
    down: "A lower threshold protects more turns, preserving sharp features but also pixel stair-step kinks.",
    performance: "More detected corners create more spans and often more cubics and optimizer blocks.",
    note: "Exactly 90 degrees qualifies. Run-length and multi-scale evidence separate a real right angle from a staircase step, so the threshold no longer has to exclude right angles to avoid pinning stairs.",
  },
  "fit-corner-window": {
    what: "Sets the calibrated support radius used to estimate corner turns.",
    how: "The fitter multiplies this reference-pixel count by solver scale, rounds it, then measures directions that many full-resolution grid edges away on each side.",
    up: "A larger window suppresses one-pixel stair steps and responds to broader shape turns.",
    down: "A smaller window preserves localized tips but is more sensitive to raster noise.",
    performance: "Corner scanning remains linear in boundary vertices; indirect segment-count effects dominate.",
    note: "It is also the base of the multi-scale octave series, which starts at twice this value. Turns are always measured on the full-resolution label grid, never on the RGB-refined contour, so the corner set does not change when a chain falls back to a planar guide.",
  },
  "fit-corner-run": {
    what: "Sets the minimum straight grid-run support for one corner-detection test.",
    how: "Adjacent runs must be long enough and their turn must remain concentrated as the support widens.",
    up: "Requires longer support; can miss short corners.",
    down: "Admits shorter runs. Zero disables this test only; window and multiscale tests remain.",
    note: "Measured in reference pixels and converted with solver scale.",
  },
  "fit-corner-octaves": {
    what: "Sets how many wider windows the multiscale corner test examines.",
    how: "Turn must survive across scales without growing too much between the widest windows.",
    up: "Tests longer-range structure, but needs longer chains and may miss small features.",
    down: "Below two disables this test. Other corner tests remain.",
    note: "Corner turn growth also affects run-based corner detection.",
  },
  "fit-corner-growth": {
    what: "Sets how much the measured turn may grow between windows before it reads as arc curvature rather than one corner.",
    how: "At a corner all the turning happens at one vertex, so widening the window does not add any. On an arc the turn grows roughly in proportion to the window. Values near one demand near-perfect concentration.",
    up: "Higher values admit turns that keep growing with scale, which starts pinning tight arcs and small round blobs as polygons.",
    down: "Lower values demand sharper concentration and reject borderline features; too low starts dropping real corners on noisy boundaries.",
    performance: "No cost of its own; fewer pinned corners generally means fewer spans and fewer cubics.",
    note: "This is the guard that keeps a small disc smooth. It also applies to run-length evidence, where long adjacent runs rule out a straight line but not a very tight arc.",
  },
  "fit-guide-smoothing": {
    what: "Blends fitted guide points toward a local boundary estimate before fitting cubics.",
    how: "Uses adaptive local support and bounded displacements to reduce grid stair steps. Optimizer targets remain unsmoothed.",
    up: "Applies more of the guide correction, up to the full blend at one.",
    down: "Zero disables guide correction, but also skips guide-based tangent estimation and corner placement refinement.",
    note: "Zero is not a clean smoothing-only comparison. Tangent window then matters more, and curve count may rise.",
  },
  "fit-topology-retries": {
    what: "Sets the fitter’s recovery budget before crossing spans fall back to exact grid edges.",
    how: "Recovery first separates grid guides from RGB targets, then reduces the pixel budget. Remaining crossings can trigger local grid spans, whole-chain grid, or finally whole-network grid.",
    up: "Allows more attempts to retain compact curves, with extra fitting and validation work.",
    down: "Reaches grid fallback sooner. Zero does not disable topology checks.",
    note: "Requires Preserve topology. Reducing the pixel budget does not tighten RMS acceptance, so more retries may not help. This is separate from optimizer retries.",
  },
  "fit-subpixel-bound": {
    what: "Caps RGB-derived interface displacement from its exact label-grid location. Applies only with RGB subpixel evidence enabled.",
    how: "A two-material box-filter estimate moves each already-existing edge along its axis, then clamps the signed offset to this pixel bound.",
    up: "A larger bound follows stronger antialias evidence farther from the grid.",
    down: "A smaller bound stays closer to label geometry and is safer on noisy or weak-color edges.",
    performance: "The clamp has negligible cost; larger offsets may trigger more topology refits or optimizer rollback.",
    note: "This is deliberately measured in actual source pixels and is not solver-scaled: adjacent-pixel box coverage is always bounded by ±0.5 source px.",
  },
  "fit-subpixel-anchor": {
    what: "Controls how strongly RGB-refined vertices remain anchored to exact grid coordinates. Applies only with RGB subpixel evidence enabled.",
    how: "The vertex consensus combines incident edge displacement votes with this non-negative grid prior.",
    up: "Higher values shrink junction and vertex motion toward the exact label network.",
    down: "Zero lets supported RGB votes determine the full bounded displacement.",
    performance: "Constant work per boundary vertex; stronger anchoring can reduce topology refits.",
    note: "This does not weaken per-sample RGB targets. If evidence-refined guides cross, ordinary guides revert to grid geometry while shared endpoint consensus and all targets are retained.",
  },
  "fit-subpixel": {
    what: "Enables RGB8 box-filter evidence for subpixel interface targets and the first initializer candidate.",
    how: "The source pixels are projected between neighboring linear-RGB region means only on edges already present in the final labels.",
    up: "On usually centers antialiased edges and reduces half-pixel grid bias.",
    down: "Off uses exact grid-edge targets and vertices, which is useful for isolating segmentation/fitter behavior.",
    performance: "Adds O(boundary length) edge evidence and consensus work after the region means are available.",
    note: "It never changes adjacency. A crossing evidence guide is automatically replaced by a planar guide, not by discarding the RGB target evidence.",
  },
  "fit-max-cubics-chain": {
    what: "Hard-limits the number of cubics emitted for one shared boundary chain.",
    how: "Recursive fitting and safe fallback stop with an error if a chain would exceed this budget.",
    up: "A larger limit permits very detailed or long interfaces.",
    down: "A smaller limit fails early instead of allowing a pathological chain to dominate memory and runtime.",
    performance: "This is a safety ceiling, not a quality target; actual work is unchanged until the limit is approached.",
    note: "Do not raise it to hide an exact-grid fallback. First inspect RMS allowance, segmentation fragments, and topology refits.",
  },
  "fit-max-total-cubics": {
    what: "Hard-limits total cubics across the fitted shared-boundary network.",
    how: "The fitter tracks emitted segments and aborts before allocating an optimizer problem beyond this count.",
    up: "A larger ceiling allows larger photographs or more detailed partitions.",
    down: "A smaller ceiling provides a stricter latency/memory guard and exposes graph explosions earlier.",
    performance: "Only a guard until reached; memory and optimizer time still scale with the actual cubic count below it.",
    note: "Production should set this from a service-level budget rather than relying on the generous lab default.",
  },
  "fit-contrast-floor": {
    what: "Controls both weak-edge target weighting and whether RGB localization is accepted.",
    how: "Floors the squared linear-RGB region contrast used in target weights. RGB localization also requires contrast above this threshold.",
    up: "Strengthens weak-edge targets but excludes more low-contrast edges from RGB localization.",
    down: "Allows localization at weaker contrasts and reduces their minimum target weight.",
    note: "Must be positive. Still affects optimizer targets when RGB subpixel evidence is off. Does not change region merging.",
  },
  "max-sweeps": {
    what: "Caps complete Yang overlapping-block passes over every chain.",
    how: "Each sweep runs conflict-colored one- or two-cubic local solves, optionally reprojects targets, and validates topology.",
    up: "More sweeps permit larger cumulative motion and later fine-sample refinement.",
    down: "Fewer sweeps return sooner but may stop before handles and joins settle.",
    performance: "Near-linear multiplier on optimizer work until relative convergence stops early.",
    note: "The paper reports that two or three traversals are often sufficient; difficult initializers may need more.",
  },
  "local-iterations": {
    what: "Caps L-BFGS iterations for each one- or two-cubic block.",
    how: "Every iteration evaluates analytic data/prior gradients and runs bounded Armijo line search.",
    up: "More iterations solve each local block more completely before neighboring blocks update.",
    down: "Fewer iterations make cheaper, more incremental passes and can work better with more sweeps.",
    performance: "Direct multiplier on local objective evaluations, bounded further by early gradient and improvement tests.",
    note: "Large values rarely help if topology rollback or poor segmentation is the actual bottleneck.",
  },
  "max-step": {
    what: "Caps Euclidean movement of each active control point during one local solve, in reference pixels.",
    how: "Every candidate is projected into a trust disk around that block's entry geometry; topology retries halve this radius.",
    up: "Larger steps correct distant initializers faster but can cross close interfaces and trigger expensive rollback.",
    down: "Smaller steps are safer for dense antialias bands but need more sweeps for large corrections.",
    performance: "Oversized steps can multiply work through topology retries; very small steps can multiply required sweeps.",
    note: "The native solver multiplies this by solver scale. For close fits, 0.1–0.5 reference px is usually safer than the former 2 px fixture value.",
  },
  "threads": {
    what: "Selects the OpenMP thread count for fitting and both optimizers.",
    how: "Zero uses the runtime default; one requests serial execution; positive values request that many workers. Actual parallel work depends on the build and stage.",
    up: "More threads help large independent chain batches until memory bandwidth and batch width saturate.",
    down: "One thread is easiest for repeatable profiling and small jobs where startup overhead dominates.",
    performance: "Too many threads can slow tiny logos. Preprocessing remains governed by its own primarily serial lazy-heap structure.",
    note: "Conflict colors execute serially, while non-conflicting blocks within one color run in parallel.",
  },
  "robust-delta": {
    what: "Sets the pseudo-Huber transition between quadratic and near-linear target displacement loss.",
    how: "The solver converts this reference-pixel value to source coordinates; normal and weak tangential residuals below it behave like squared error and larger gradients saturate smoothly.",
    up: "A larger delta treats farther errors quadratically and gives outliers more influence.",
    down: "A smaller delta is more robust to wrong targets but can move a distant initializer more slowly.",
    performance: "Constant evaluation cost; extreme values can change line-search and sweep counts.",
    note: "The 0.25 reference-px default is resolution-covariant. It is separate from the unscaled ±0.5 source-pixel evidence bound.",
  },
  "data-weight": {
    what: "Scales boundary evidence relative to the three geometric priors.",
    how: "Contrast-weighted pseudo-Huber normal/tangent loss is accumulated with represented arc length, then scaled according to the selected Normalization mode.",
    up: "Higher values pull curves toward segmented/RGB targets more strongly relative to shape priors.",
    down: "Zero disables image evidence; priors can then shrink or regularize away from the raster.",
    performance: "No direct complexity change, though stronger competition can increase line-search work.",
    note: "Weights must be non-negative. Their numerical meaning changes with Normalization, so compare modes with retuned priors rather than assuming identical values are equivalent.",
  },
  "normalization": {
    what: "Chooses how objective terms are scaled; it never rescales curve coordinates.",
    how: "Off uses raw data and raw APT/HPT/LPT sums. Yang divides only data by one fixed initial arc length l₀ for the whole boundary network. Scale-balanced reproduces the earlier per-chain data/length and segment/handle balancing.",
    up: "Yang reduces the entire data gradient by global l₀; Scale-balanced also equalizes short and long chains and suppresses prior growth with segment count.",
    down: "Off gives long, high-contrast boundaries proportionally more influence and keeps the paper priors as literal raw sums.",
    performance: "Arithmetic cost is identical. Scaling changes line-search behavior, topology retries, and the weight range that converges well.",
    note: "Yang's paper uses data/l₀ with raw priors. Off remains the tuned default. Coordinate scaling is independent and analytically rescales APT/HPT/LPT for whichever normalization mode is selected.",
  },
  "tangent-weight": {
    what: "Scales the weak target-tangent displacement inside the data term.",
    how: "Each sample decomposes curve error into its stored normal and perpendicular tangent; this multiplies only the tangent loss.",
    up: "Higher values enforce the initial along-boundary correspondence more strongly.",
    down: "Zero optimizes only normal alignment and allows samples to slide freely along the interface.",
    performance: "Negligible extra cost because both residuals share the same curve evaluation.",
    note: "Keep it much smaller than Data; a large value can fight sample reprojection and pin bad parameterization.",
  },
  "angle-weight": {
    what: "Scales the smooth tangent-turn prior at interior cubic joins.",
    how: "A stable atan2 join-angle penalty is differentiated analytically; it is a raw sum in Off/Yang and divided by chain segment count only in Scale-balanced mode.",
    up: "Higher values smooth false corners and favor aligned incoming/outgoing handles.",
    down: "Zero permits any join angle supported by data; real corners are otherwise softened if this is too high.",
    performance: "Small fixed work per join per objective evaluation.",
    note: "Yang specifically notes this weight may need tuning on low-resolution input. It is not applied at pinned open-chain endpoints.",
  },
  "handle-weight": {
    what: "Scales the inverse-handle-length barrier.",
    how: "Every handle contributes a reciprocal-length penalty with a small finite epsilon; only Scale-balanced mode applies characteristic-length and segment-count scaling.",
    up: "Higher values resist collapsed handles and unstable cusps.",
    down: "Zero allows very short handles if data and other priors prefer them.",
    performance: "Constant work per handle per local evaluation.",
    note: "This is a soft prior, not the fitter's hard handle/admissibility checks.",
  },
  "length-weight": {
    what: "Scales cubic arc length.",
    how: "Five-point Gauss–Legendre speed quadrature sums current length. Off and Yang keep the raw sum; Scale-balanced divides each chain by its fixed initial length.",
    up: "Higher values discourage unsupported wiggles and favor shorter geometry.",
    down: "Zero removes shrink pressure and leaves shape length to data and other priors.",
    performance: "Adds fixed quadrature work per cubic per objective evaluation regardless of the value.",
    note: "Too high a value shrinks bowls, rounds protrusions, and can pull against low-contrast targets.",
  },
  "preserve-topology": {
    what: "Enables topology validation and recovery in the fitter and both optimizers.",
    how: "Fitting repairs crossing spans. Optimizers reduce motion or roll back offending chains and revalidate the whole network before accepting updates.",
    up: "On keeps the geometry subject to topology checks.",
    down: "Off bypasses those safety checks and may produce crossings or a rasterizer error.",
    note: "Keep on for vector output. It cannot recover shapes already removed by merging. In raster mode, refit after changing this setting.",
  },
  "reproject-samples": {
    what: "Refreshes each target's closest parameter on its assigned cubic.",
    how: "A bounded Newton solve updates t before the first sweep and again between later sweeps without changing segment assignment.",
    up: "On reduces bias when controls move tangentially or the initializer parameterization is poor.",
    down: "Off freezes target parameters, improving reproducibility and speed for controlled fixtures.",
    performance: "Adds a few derivative evaluations per target per sweep, usually small beside local L-BFGS work.",
    note: "It cannot move a target to another cubic; fit segmentation and target assignment remain authoritative.",
  },
  "lbfgs-history": {
    what: "Sets the number of recent curvature pairs retained by each fixed-size local L-BFGS solve.",
    how: "The two-loop recursion uses up to this many stack-resident s/y pairs to scale and rotate the descent direction.",
    up: "More history can reduce iterations on coupled blocks but has diminishing returns.",
    down: "One approaches scaled gradient descent and uses the least arithmetic.",
    performance: "Cost grows with history × active dimensions × local iterations; memory remains fixed and stack-local.",
    note: "The native maximum is eight.",
  },
  "coarse-stride": {
    what: "Sets the initial target-sample stride for coarse-to-fine sweeps.",
    how: "Early sweeps take every Nth sample with compensated weights; the stride halves each sweep until it reaches one.",
    up: "Higher values make early large-error correction cheaper but see less local evidence.",
    down: "One evaluates all targets from the first sweep and gives the most predictable quality.",
    performance: "Can reduce early data evaluations nearly in proportion to the stride.",
    note: "Priors always use full quadrature; only retained target samples are strided.",
  },
  "line-search-steps": {
    what: "Caps Armijo backtracking probes for each local L-BFGS iteration.",
    how: "A failed candidate halves its step until sufficient objective decrease is found or this count is exhausted.",
    up: "More probes can rescue a difficult descent direction with a very small step.",
    down: "Fewer probes stop unproductive local iterations sooner.",
    performance: "Worst-case objective evaluations per iteration grow linearly with this value.",
    note: "Frequent exhaustion usually indicates poor scaling, an oversized trust radius, or conflicting priors.",
  },
  "projection-iterations": {
    what: "Caps Newton iterations used by optimizer sample reprojection.",
    how: "Each step uses cubic first/second derivatives and is clamped before t is returned to [0,1].",
    up: "More iterations improve closest-point convergence on strongly curved segments.",
    down: "Zero leaves parameters unchanged even if Reproject samples is on.",
    performance: "Linear in targets × sweeps × this bound, with early exit on small updates.",
    note: "Two is normally enough for the close shared-boundary initializer; increase it only when curves move substantially along their tangents.",
  },
  "gradient-tolerance": {
    what: "Stops a local solve when the largest absolute gradient component is small enough.",
    how: "The infinity norm of the analytic gradient is compared with this non-negative threshold.",
    up: "A larger tolerance exits local blocks earlier with less precision.",
    down: "A smaller tolerance permits finer local convergence and more iterations.",
    performance: "Can materially reduce work when increased; zero disables gradient-based early stopping.",
    note: "The useful value depends on Normalization, weights, contrast, and network length; raw mode generally produces larger gradients than normalized modes.",
  },
  "relative-tolerance": {
    what: "Stops local iterations and fine sweeps when relative energy improvement becomes negligible.",
    how: "Energy decrease is divided by max(1, |energy|) and compared with this non-negative value.",
    up: "A larger tolerance converges earlier and may leave small visible corrections undone.",
    down: "A smaller tolerance spends more work chasing tiny decreases.",
    performance: "Directly controls early exit frequency; zero effectively requires exact stagnation.",
    note: "Sweep convergence is checked only after the sample stride reaches one.",
  },
  "optimizer-topology-retries": {
    what: "Bounds boundary-optimizer retries when proposed motion creates crossings.",
    how: "Reduces the trust radius on implicated chains; persistent offenders can be held at their previous geometry while other chains continue.",
    up: "Allows more recovery attempts, at extra solve and validation cost.",
    down: "Limits retries but may leave less useful motion.",
    note: "Applies only to the boundary optimizer with Preserve topology on. Fitter recovery and filled-RGB line search have separate budgets.",
  },
  "topology-flatness": {
    what: "Sets the maximum curve-to-chord deviation used when flattening cubics for topology checks.",
    how: "The solver converts this reference-pixel tolerance to source coordinates; De Casteljau subdivision continues until it and a cell-length bound are satisfied.",
    up: "A larger value starts with fewer subcurves, but their overlapping hulls may require more intersection work.",
    down: "A smaller value starts with more subcurves and tighter bounds, at greater indexing cost.",
    performance: "Fragment count can grow quickly as the tolerance shrinks, increasing spatial-hash occupancy and pair tests.",
    note: "Used by both optimizers, not the fitter. The checker tests actual cubic subcurves, not just flattened chords, and rejects unresolved numerical contacts. This is work granularity, not a smoothing control.",
  },
  "topology-cell-size": {
    what: "Sets spatial-hash cell size for flattened topology edges.",
    how: "This reference-pixel size is solver-scaled; every flattened line fragment is inserted into overlapped source-coordinate cells and tested only against prior occupants.",
    up: "Larger cells reduce hash entries but increase candidate edge pairs per cell.",
    down: "Smaller cells reduce local pair density but duplicate fragments across more cells.",
    performance: "Best near the typical local curve scale; extremes can make topology checks much slower without changing results.",
    note: "Used by both optimizers, not the fitter. Flattened fragment length is also capped at 0.75 times this size.",
  },
  "angle-epsilon": {
    what: "Smooths the absolute angle prior at exactly zero turn.",
    how: "The optimizer uses sqrt(theta² + epsilon²) − epsilon instead of a non-differentiable absolute value.",
    up: "A larger epsilon softens the prior near smooth joins.",
    down: "A smaller positive epsilon more closely approximates absolute angle but sharpens local curvature.",
    performance: "No complexity impact; extremely small values can worsen numerical conditioning.",
    note: "Must remain positive and is measured in radians.",
  },
  "handle-epsilon": {
    what: "Regularizes the inverse-handle barrier near zero length.",
    how: "Handle length is evaluated as sqrt(length² + epsilon²) before taking its reciprocal.",
    up: "A larger epsilon caps the barrier and weakens its response to extremely short handles.",
    down: "A smaller positive epsilon makes collapse increasingly expensive but can create steep gradients.",
    performance: "No complexity impact; overly small values can increase line-search backtracking.",
    note: "Entered in reference pixels and converted with the same solver scale as geometry, so HPT retains its intended strength across resolutions.",
  },
  "display-targets": {
    what: "Shows the optimizer's retained target observations as unconnected dots.",
    how: "Each dot is an arc-bin average of one or more RGB-shifted grid-edge midpoints. The dots are not a continuous path, so the browser deliberately does not connect them.",
    up: "On reveals observation density, missing coverage, endpoint clamps, and disagreement with fitted curves.",
    down: "Off gives an uncluttered curve/raster comparison.",
    performance: "Browser-only drawing cost, capped to a few thousand visible points.",
    note: "It has no effect on fitting or optimization. Red dots have clamped, duplicate, reversed, or invalid initial assignments.",
  },
  "display-evidence": {
    what: "Shows the fitter's connected source-evidence scaffold.",
    how: "The path alternates shared refined grid vertices with the RGB-localized observation on each intervening grid edge. Unlike Target dots, consecutive points have explicit source adjacency.",
    up: "On reveals whether a leak begins in the connected source evidence or is introduced by curve fitting and optimization.",
    down: "Off leaves the exact label grid, target dots, and fitted curves available separately.",
    performance: "Browser-only drawing. At most five hundred thousand source segments are drawn; larger paths are displayed sparsely without connecting skipped points.",
    note: "Diagnostic only: the current optimizer still uses the bounded Target dots. This scaffold is not yet a smoothed posterior contour or optimizer quadrature.",
  },
  "display-assignments": {
    what: "Draws a spoke from each displayed target dot to its assigned point on the initial cubic.",
    how: "The spoke endpoint is evaluated from the sample's published segment and t. Spokes appear only where those initializer assignments are meaningful.",
    up: "On exposes incorrect segment ownership, projection collapse, and large target-to-curve residuals directly.",
    down: "Off leaves only the target dots and curve geometry.",
    performance: "Browser-only drawing, capped to roughly twelve hundred ordinary spokes plus every flagged assignment.",
    note: "The native optimizer may reproject its private copy of t, so the lab does not draw these initializer spokes on the Optimized curves stage.",
  },
  "display-label-boundary": {
    what: "Shows the exact connected shared boundary implied by the discrete label raster.",
    how: "Every horizontal or vertical grid edge separating two region labels is drawn at its true pixel-grid coordinate, independently of RGB targets and fitted curves.",
    up: "On gives the authoritative topology reference and makes leaks outside the surviving labeled regions easy to see.",
    down: "Off removes the grid-line reference while retaining target dots and curves.",
    performance: "Browser-only drawing. The exact overlay is disabled rather than sampled if it exceeds five hundred thousand segments.",
    note: "This is the connected label contour, not a subpixel RGB contour and not the old blue target polyline.",
  },
  "display-normals": {
    what: "Shows a sparse subset of target normals.",
    how: "Short screen-space line segments use the stored unit normal orientation for diagnostic display.",
    up: "On helps find reversed or inconsistent boundary evidence.",
    down: "Off reduces visual clutter.",
    performance: "Small browser-only drawing cost; native work is unchanged.",
    note: "Normals are orientation-stable by region ID; the data loss is symmetric in their sign. Target dots must also be enabled.",
  },
  "display-controls": {
    what: "Shows cubic handles, knots, and control polygons on editable initial-curve previews.",
    how: "Fixture and Initial curves stages draw all controls; fixture controls can be dragged and shared endpoints move together.",
    up: "On exposes short handles, overshoot, join continuity, and block layout.",
    down: "Off shows only curve paths.",
    performance: "Browser drawing and hit-testing scale with control count; the batch fixture is clearer with this off.",
    note: "Optimized controls are display-only; edit the initializer and rerun instead of mutating a reported result.",
  },
  "display-initial": {
    what: "Overlays the dashed initializer when an optimized result is available.",
    how: "The browser retains baseline control points separately from the native copy-out result.",
    up: "On makes direction and magnitude of Yang's change visible.",
    down: "Off isolates the optimized curve.",
    performance: "One extra browser curve pass; native work is unchanged.",
    note: "On the Initial curves stage, the initializer is always shown regardless of this comparison toggle. This defaults off to keep the final preview readable.",
  },
  "overlay-opacity": {
    what: "Sets source-raster opacity behind Initial curves and Optimized previews.",
    how: "The browser composites the local source image before vector diagnostics; Source and flat-region stages remain fully opaque.",
    up: "Higher opacity makes raster fidelity easier to judge but can obscure thin vector lines.",
    down: "Lower opacity emphasizes curves and controls; zero hides the raster only on curve stages.",
    performance: "Browser compositing only; no native performance impact.",
    note: "The source raster is never combined with synthetic test cases.",
  },
  "raster-refine-enabled": {
    what: "Adds a direct filled-RGB geometry pass after the fast boundary/prior optimizer.",
    how: "The initializer fixes global l₀; analytic pixel-box data and APT/HPT/LPT gradients then update the same shared controls through overlapping two-cubic systems.",
    up: "On makes final curves respond to actual filled pixel residuals and is the recommended raster workflow.",
    down: "Off isolates the faster target-sample/prior implementation for profiling or comparison.",
    performance: "Adds sparse boundary-band renders, gradients, and line searches. Cost follows active boundary pixels rather than total region interiors.",
    note: "This uses a fixed-sample box raster derivative instead of Yang's hierarchical Haar renderer, but now matches the paper's coupled two-cubic variable layout and joint data/prior acceptance objective.",
  },
  "raster-refine-colors": {
    what: "Optimizes Yang's per-region RGB variables C as well as the Bezigon geometry B.",
    how: "At fixed geometry, exact subpixel region coverages form a sparse normal system H = AᵀA and b = AᵀI. Three deterministic preconditioned conjugate-gradient solves update RGB before and after the geometry sweeps.",
    up: "On lets flat colors compensate for antialias-contaminated VBRM means, separating color error from boundary placement. It substantially improves the supplied 16-region logo.",
    down: "Off holds the VBRM region means fixed, which isolates geometry timing and reproduces the earlier geometry-only optimizer.",
    performance: "Adds one full source/label statistics scan, sparse coverage capture, and two small three-channel solves. On the supplied logo it added about 4 ms while gaining 5.09 dB.",
    note: "Color solves do not change Joint normalization because priors are constant while C is solved. Colors remain clamped to [0,1], and a tiny anchor protects regions with little visible area.",
  },
  "raster-refine-sweeps": {
    what: "Caps global filled-RGB control-point updates.",
    how: "Each sweep visits every block once. Additive scheduling uses one residual state and acceptance render; Ordered colors refreshes the residual and derivative between non-conflicting block batches.",
    up: "More sweeps allow more cumulative correction and finer settling after the boundary pass.",
    down: "Fewer sweeps reduce latency and are sufficient when the initializer is already within a fraction of a pixel.",
    performance: "Nearly linear multiplier until convergence. Ordered colors performs two or three derivative/acceptance batches inside each sweep, so compare work with Geometry batches in the report.",
    note: "The paper reports two or three traversals are usually enough. Measured here that is wrong: at three sweeps the stage is still improving on every image tried, and raising the default to twelve is worth 1.57 dB of filled PSNR on the logo at 52 regions. The logo at 16 regions converges by itself at thirteen; past twelve the rest costs more turning than it gains.",
  },
  "raster-refine-samples": {
    what: "Sets the maximum supersamples per axis for direct filled-RGB refinement.",
    how: "Pixels crossed by a cubic average an S×S deterministic fill. Curve-free active pixels are constant faces and use one exact lookup; the control gradient is integrated between exact pixel-grid crossings.",
    up: "Higher values make coverage and line-search decisions less quantized, at greater sampling cost.",
    down: "Lower values reduce boundary sampling but can reject useful movements or bias fitted colors when an edge falls between sample locations.",
    performance: "Only curve-crossed pixels grow as S²; scanline intersection work grows roughly with S. Cost still rises with boundary density, so 8 is the quality/performance default.",
    note: "This controls the optimizer residual, not the separate full-frame reference renderer. Compare Final SVG first; use one common higher-accuracy raster setting for numeric comparisons.",
  },
  "raster-refine-max-step": {
    what: "Caps one accepted geometry batch's motion for every movable control point in reference pixels.",
    how: "The native solver converts the radius to source pixels before clipping coupled-block or diagonal proposals; open-chain endpoints remain pinned. Ordered colors can touch a control in multiple batches.",
    up: "Larger values can correct a worse initializer faster but may overshoot discrete supersample thresholds or approach neighboring interfaces.",
    down: "Smaller values are more stable and precise but limit total correction to roughly sweeps × this value.",
    performance: "Oversized steps cause more line-search and topology rejections; tiny steps may require more sweeps.",
    note: "The displayed solver scale performs that conversion without an optimization pyramid or any raster resize.",
  },
  "raster-refine-step-scale": {
    what: "Scales the damped Gauss–Newton proposal before the hard movement cap.",
    how: "It multiplies each solved two-cubic block vector, or each independent coordinate in diagonal mode, before overlapping contributions are averaged.",
    up: "Higher values are more aggressive and often hit Max step; too high spends work backtracking.",
    down: "Lower values make steadier, smaller updates and can resolve oscillation at the cost of more sweeps.",
    performance: "No direct arithmetic cost, but it strongly affects line-search evaluations and accepted sweep count.",
    note: "Tune this before reducing damping when the gradient direction is useful but candidates overshoot.",
  },
  "raster-refine-active-margin": {
    what: "Adds calibrated reference pixels around the boundary motion envelope used by sparse residual rendering.",
    how: "After conversion to source pixels, the active mask covers every initial cubic hull, cumulative allowed movement, antialias support, and this additional margin.",
    up: "A larger margin protects against missing residual changes around unusual curves or wide moves.",
    down: "Zero minimizes band area but leaves only the mandatory support and motion allowance.",
    performance: "Directly increases active pixels along boundary length; unlike full-frame rendering it does not add distant region interiors.",
    note: "The report exposes active pixels. If this approaches full image area, segmentation is too fragmented or the margin/step budget is excessive.",
  },
  "raster-refine-band-height": {
    what: "Sets horizontal curve-index band height for sparse refinement renders.",
    how: "Cubics are registered only in touched bands so each active scanline tests a local candidate list.",
    up: "Larger bands use fewer index lists but test more unrelated cubics per scanline.",
    down: "Smaller bands prune tests more tightly but duplicate tall curves across more lists.",
    performance: "Changes cubic intersection tests, not active pixel count or samples per pixel; 16–64 px is usually effective.",
    note: "This parameter cannot change the optimum—only indexing cost.",
  },
  "raster-refine-color-space": {
    what: "Chooses the RGB coordinates minimized by direct filled-raster refinement.",
    how: "sRGB uses stored image values as Yang does; Linear applies the sRGB transfer curve before residuals and region-color differences.",
    up: "Linear emphasizes physically linear coverage and bright-value errors.",
    down: "sRGB matches the paper's arbitrary RGB objective, conventional PSNR, and current logo tuning.",
    performance: "Linear adds inexpensive lookups; scan conversion and derivative complexity are unchanged.",
    note: "Use the same space for refinement and the final score when comparing data energy; numbers across spaces are not comparable.",
  },
  "raster-refine-geometry-solver": {
    what: "Chooses whether filled-raster geometry coordinates are solved independently or in Yang-style overlapping curve pieces.",
    how: "Overlapping mode assembles a dense Gauss–Newton system for the five movable control points of each adjacent two-cubic piece (10 coordinates), averages shared proposals, and performs one global raster line search.",
    up: "Overlapping blocks couple x/y, handles, and the shared join, improving corner and curvature corrections. They gained about 0.84 dB over diagonal mode on the logo's common 32× oracle at 8× sampling.",
    down: "Independent coordinates reproduce the earlier diagonal preconditioner and are useful as a speed/bisect baseline, but cannot model cross-control coverage sensitivity.",
    performance: "Dense systems are at most 10×10. On the 4K synthetic case they added about 3.4% to one-thread raster refinement; raster evaluation still dominates.",
    note: "Both modes use the same topology transaction and complete-objective acceptance test. Block schedule applies only to Overlapping mode; a failed block factorization falls back to diagonal and is counted in the report.",
  },
  "raster-refine-block-schedule": {
    what: "Chooses how overlapping geometry blocks share updated image residuals.",
    how: "Additive combines proposals from one residual. Ordered colors updates nonconflicting batches and refreshes residuals between them.",
    up: "Ordered colors may need fewer sweeps but performs more derivative and rendering work per sweep.",
    down: "Additive is the faster-per-sweep default.",
    note: "Only applies to the overlapping-block solver. Independent coordinates always uses Additive. Compare elapsed time and geometry batches, not just sweep count.",
  },
  "raster-refine-normalization": {
    what: "Chooses the relative scaling of filled RGB data and the joint APT/HPT/LPT priors; geometry remains in source coordinates.",
    how: "Off minimizes raw SSE plus raw priors (the whole sum is divided by fixed l₀ only for numerical conditioning). Yang divides only SSE by l₀ and leaves priors raw.",
    up: "Yang makes the same positive prior weights l₀ times stronger relative to image data, so curves become smoother/shorter unless all three weights are retuned downward.",
    down: "Off lets unnormalized pixel evidence compete with raw priors and is the tuned default for this shared-network initializer.",
    performance: "Arithmetic cost is unchanged, but an over-strong normalized prior can cause more backtracking or accept a visibly lower-fidelity optimum.",
    note: "Off remains the tuned default. The coordinate-scale contract analytically converts all three prior weights for Off or Yang, but does not make the two normalization modes numerically interchangeable.",
  },
  "raster-refine-damping": {
    what: "Stabilizes division by weak or zero local coverage sensitivity.",
    how: "This positive value is added to every dense-block or diagonal Gauss–Newton diagonal before converting the joint gradient into control movement.",
    up: "More damping shrinks poorly constrained handle directions and produces conservative steps.",
    down: "Less damping allows larger corrections on weak-contrast or weakly supported controls but can amplify noise and hit the step cap.",
    performance: "No direct cost; unstable low values increase backtracking, while high values may require extra sweeps.",
    note: "Keep it positive. If most controls hit Max step, Step scale or Max step dominates and damping changes may be invisible.",
  },
  "raster-refine-line-search": {
    what: "Limits attempts to find a topology-valid, improving filled-RGB geometry update.",
    how: "Candidates undergo local motion reduction or chain rollback, topology validation, and rendered data-plus-prior descent checks.",
    up: "Allows more chances to find an acceptable step, with extra rendering work.",
    down: "Stops rejected proposals sooner.",
    note: "No accepted geometry update means a stalled step, not successful convergence. Inspect the report before simply increasing this budget.",
  },
  "raster-refine-relative-tolerance": {
    what: "Stops raster sweeps when relative joint-objective improvement is negligible.",
    how: "Accepted data-plus-prior decrease is divided by the magnitude of the previous conditioned objective and compared with this non-negative threshold.",
    up: "A larger value exits earlier and ignores smaller visible corrections.",
    down: "A smaller value permits more fine sweeps until quantized residual evaluation stagnates.",
    performance: "Controls early exit frequency; zero runs until no improving step or the sweep cap.",
    note: "Because only geometry-dependent active pixels plus global curve priors are scored, constant interior raster error is intentionally excluded from this convergence ratio.",
  },
  "raster-refine-angle-weight": {
    what: "Scales Yang's angle-variation prior (APT) inside the same objective used to accept filled-raster moves.",
    how: "Every movable cubic join contributes a smooth absolute atan2 turn penalty and its analytic gradient; Off normalization keeps its raw weight relative to raw raster SSE.",
    up: "Higher values align neighboring handles and remove unsupported kinks; too high rounds intentional corners and can sacrifice pixel fidelity.",
    down: "Lower values let raster evidence determine join angles more freely; zero removes APT from the joint stage while the earlier boundary pass remains unchanged.",
    performance: "Adds constant work per join to each differential and line-search objective, negligible beside sparse rasterization; strong values can increase backtracking.",
    note: "The tuned default is 0.001 with normalization Off. Retune by roughly the network length scale before comparing Yang normalization.",
  },
  "raster-refine-handle-weight": {
    what: "Scales Yang's inverse-handle prior (HPT) in the joint filled-raster objective.",
    how: "Each cubic handle contributes weight / sqrt(length² + epsilon²), so its analytic gradient pushes dangerously short handles away from collapse.",
    up: "Higher values produce longer, more editable handles and suppress cusp-like collapses; too high can overshoot tight bends.",
    down: "Lower values let data shorten handles; zero removes HPT from the joint stage.",
    performance: "Constant work per handle and negligible allocation; steep barriers can require smaller line-search steps.",
    note: "This is a soft editability prior. It does not replace topology checks or the initializer's admissibility rules.",
  },
  "raster-refine-length-weight": {
    what: "Scales Yang's curve-length prior (LPT) in the joint filled-raster objective.",
    how: "Five-point Gauss–Legendre speed quadrature sums every cubic's arc length and differentiates it with respect to all four controls.",
    up: "Higher values shorten unsupported loops and wiggles; too high shrinks bowls, thins protrusions, and fights low-contrast edges.",
    down: "Lower values preserve data-driven length; zero removes LPT from the joint stage.",
    performance: "Fixed five-sample work per cubic per differential/objective probe, normally tiny relative to raster sampling.",
    note: "The tuned joint value 0.0005 is intentionally lower than the preceding boundary-pass LPT because filled SSE already constrains shape strongly.",
  },
  "raster-refine-angle-epsilon": {
    what: "Smooths the joint APT absolute value at a perfectly aligned join.",
    how: "APT uses sqrt(turn² + epsilon²) − epsilon, avoiding a non-differentiable cusp at zero radians.",
    up: "A larger positive value softens APT near smooth joins and reduces its local curvature.",
    down: "A smaller positive value more closely approximates absolute turn but makes the gradient change more sharply near alignment.",
    performance: "No complexity change; extremely small values can worsen numerical conditioning and backtracking.",
    note: "Measured in radians and required to be positive. It affects only the joint raster pass, not the boundary pass epsilon above.",
  },
  "raster-refine-handle-epsilon": {
    what: "Regularizes the joint HPT reciprocal barrier at zero handle length.",
    how: "HPT replaces handle length by sqrt(length² + epsilon²) before taking its reciprocal.",
    up: "A larger positive value caps and weakens the barrier for nearly collapsed handles.",
    down: "A smaller positive value makes collapse more expensive but creates a steeper gradient.",
    performance: "No complexity change; values far below useful coordinate precision can increase line-search work.",
    note: "Entered in reference pixels and converted to source coordinates. It is independent of the boundary-pass handle epsilon.",
  },
  "raster-refine-color-iterations": {
    what: "Caps preconditioned conjugate-gradient iterations for each sparse region-color PCG solve.",
    how: "Each iteration multiplies the region adjacency-like normal matrix by one RGB channel and applies its diagonal preconditioner; the solve stops earlier at Color tolerance.",
    up: "More iterations can resolve strongly coupled thin or overlapping antialias regions more accurately.",
    down: "Fewer iterations bound color-solve latency; well-separated flat regions often converge before the default cap.",
    performance: "Linear worst-case cost in this cap, with each iteration proportional to regions plus nonzero co-coverage pairs. Two color solves may run per refinement call.",
    note: "The report counts total iterations across all accepted and attempted color solves. Raising the cap cannot help after the residual tolerance is reached.",
  },
  "raster-refine-color-regularization": {
    what: "Anchors optimized colors weakly to the incoming VBRM means.",
    how: "A Tikhonov diagonal λI and matching λC₀ term are added to the coverage normal equations; λ scales with image area so its per-pixel strength is resolution-covariant.",
    up: "Higher values keep colors closer to the segmentation means and stabilize tiny or nearly hidden regions.",
    down: "Lower values let the pixel objective determine colors more freely; zero removes the anchor entirely.",
    performance: "Negligible direct cost. A sensible positive value can improve conditioning and reduce PCG iterations.",
    note: "The default is calibrated at unit solver scale and the native stage multiplies it by scale². Large values can preserve antialias-biased VBRM colors and forfeit the main quality gain.",
  },
  "raster-refine-color-tolerance": {
    what: "Sets the relative residual target for each sparse region-color PCG solve.",
    how: "PCG stops when the Euclidean residual norm is at most this value times max(1, the right-hand-side norm), or when the iteration cap is reached.",
    up: "A larger tolerance exits sooner with a less exact color solution.",
    down: "A smaller tolerance requests a more accurate solve and may use more iterations.",
    performance: "Lower values can increase solve time up to Color PCG iterations; geometry rasterization cost is unchanged.",
    note: "This is a solver residual criterion, not an RGB error threshold. Values near machine precision usually waste work without visible benefit.",
  },
  "live-rebuild": {
    what: "Automatically rebuilds pipeline stages after parameter or handle edits.",
    how: "Changes are coalesced with a 500 ms debounce, then the earliest affected stage re-runs and every later stage that already had results is replayed.",
    up: "On is for interactive tuning: move a slider or drag a handle and the current tab updates without pressing Run.",
    down: "Off requires explicit Discrete / Fit / Optimize / Render actions and is safer for expensive high-resolution work.",
    performance: "Each settled edit can re-run discrete, fit, optimize (including filled-RGB refinement), and filled scoring in sequence. Prefer Off for large images or high sample counts.",
    note: "Tab and zoom are preserved across live rebuilds. Loading defaults or switching fixtures does not trigger a rebuild.",
  },
  "raster-samples": {
    what: "Sets the horizontal and vertical box samples used for every pixel in the native filled-region reference.",
    how: "For S samples per axis, the scan converter traces S horizontal subrows and averages S×S region-color samples into each output pixel. The initializer's measured network length l₀ is frozen and reused for the optimized score.",
    up: "Higher values resolve curved subpixel coverage more accurately and make the full RGB score a stronger approximation to Yang's box-filtered Haar raster.",
    down: "Lower values make the preview faster but quantize edge coverage; one is a hard, center-sampled fill with no antialiasing.",
    performance: "Render work and sample count grow quadratically: doubling S costs about four times as much. The lab default is 32 for logo-grade validation; use 4–8 for interactive crops.",
    note: "This controls the full-frame validation oracle. Direct refinement has its own sampler so you can tune optimization speed independently. Never recompute l₀ between the initial and final fill.",
  },
  "raster-band-height": {
    what: "Sets the height of the native curve-index bands used before filled scan conversion.",
    how: "Each cubic is registered only with horizontal bands touched by its control-hull y range; a scanline tests cubics in its current band instead of the whole network.",
    up: "Larger bands reduce index entries but make each scanline test more unrelated cubics.",
    down: "Smaller bands prune curve tests more aggressively but create a larger index and duplicate tall cubics across more bands.",
    performance: "This changes indexing and candidate tests, not subpixel sample count. Values around 16–64 px usually balance sparse vector networks.",
    note: "The report exposes band count and cubic tests. It never changes geometry, coverage, or the Yang RGB score.",
  },
  "raster-color-space": {
    what: "Chooses the RGB coordinates used to mix region coverage and measure the full pixel residual.",
    how: "sRGB averages encoded image values, matching Yang's arbitrary RGB formulation and conventional PSNR; Linear converts source pixels and region means through the sRGB transfer function first.",
    up: "Linear RGB emphasizes errors in bright values and models physically linear light/coverage.",
    down: "sRGB follows the stored pixel values directly and matches the existing logo tuning measurements.",
    performance: "Both modes have the same scan-conversion cost; linear mode adds a small lookup/conversion cost per channel.",
    note: "Scores from different spaces are not numerically comparable. Use sRGB to reproduce the paper-style image objective and linear only as a separate diagnostic.",
  },
  "raster-auto-score": {
    what: "Controls whether the lab renders and scores both filled stages immediately after boundary optimization.",
    how: "On first renders the initializer to freeze Yang's l₀, then renders the optimized controls with that same l₀ and reports both full RGB losses.",
    up: "On supplies numeric comparisons at the current labels, colors, and score space.",
    down: "Off keeps optimization latency isolated; use Render filled stages only when you want the slower oracle.",
    performance: "Adds two raster passes after each optimize. Cost scales with source pixels, samples-per-axis squared, and the band-index candidate count.",
    note: "When filled-RGB refinement is enabled, scoring validates its result with a separate full-frame pass; when disabled, it measures the boundary-only result.",
  },
});

function controlName(control) {
  const explicit = document.querySelector(`label[for="${control.id}"]`);
  const wrapped = control.closest("label");
  const source = explicit || wrapped;
  const text = source?.querySelector("span")?.textContent || source?.textContent;
  return text?.trim() || control.id;
}

function parameterApplyHelp(id) {
  if (id === "preprocess-saliency" || id === "preprocess-topology") return "Unavailable for browser inputs.";
  if (id === "threads") return "Used by the next fit or optimization run.";
  if (id === "preserve-topology") return "Raster: Fit curves → Optimize. Fixture: Optimize.";
  const stage = liveRebuildStageForControl(id);
  if (stage === "discrete") return "Run discrete → Fit curves → Optimize, or enable Live rebuild.";
  if (stage === "fit") return "Fit curves → Optimize, or enable Live rebuild.";
  if (stage === "score") return "Render filled stages; SVG geometry is unchanged.";
  if (stage === "optimize") return "Run Optimize, or enable Live rebuild. No refit is needed.";
  return null;
}

function installParameterHelp() {
  const controls = [
    $("preset-select"),
    $("live-rebuild"),
    ...document.querySelectorAll(
      ".inspector input[id]:not([type='file']), .inspector select[id]",
    ),
  ];
  let open = null;
  const closeOpen = () => {
    if (!open) {
      return;
    }
    open.panel.hidden = true;
    open.button.setAttribute("aria-expanded", "false");
    open.button.setAttribute("aria-label", `Show help for ${open.name}`);
    open = null;
  };
  for (const control of controls) {
    const copy = parameterHelp[control.id];
    if (!copy) {
      console.error(`Missing parameter help for ${control.id}`);
      continue;
    }
    const label = control.closest("label");
    if (!label) {
      continue;
    }
    const host = document.createElement("div");
    host.className = "param-control";
    if (control.type === "checkbox" || control.type === "range") {
      host.classList.add("compact-help");
    }
    label.parentNode.insertBefore(host, label);
    host.appendChild(label);

    const name = controlName(control);
    const panel = document.createElement("div");
    panel.id = `help-${control.id}`;
    panel.className = "param-help";
    panel.hidden = true;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", `${name} help`);
    const descriptions = document.createElement("dl");
    const topics = [
      ["What it does", copy.what],
      ["How it works", copy.how],
      ...(control.tagName === "SELECT"
        ? [["Tradeoffs", [copy.up, copy.down].filter(Boolean).join(" ")]]
        : [[control.type === "checkbox" ? "When enabled" : "Higher", copy.up],
           [control.type === "checkbox" ? "When disabled" : "Lower", copy.down]]),
      ["Performance impact", copy.performance],
      ["Caution", copy.note],
      ["Apply changes", parameterApplyHelp(control.id)],
    ];
    for (const [term, description] of topics) {
      if (!description) continue;
      const heading = document.createElement("dt");
      heading.textContent = `${term}: `;
      const detail = document.createElement("dd");
      detail.textContent = description;
      descriptions.append(heading, detail);
    }
    panel.appendChild(descriptions);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "param-help-toggle";
    button.textContent = "?";
    button.setAttribute("aria-controls", panel.id);
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", `Show help for ${name}`);
    control.setAttribute("aria-describedby", panel.id);
    button.addEventListener("click", () => {
      const wasOpen = button.getAttribute("aria-expanded") === "true";
      closeOpen();
      if (!wasOpen) {
        panel.hidden = false;
        button.setAttribute("aria-expanded", "true");
        button.setAttribute("aria-label", `Hide help for ${name}`);
        open = { button, panel, name };
        panel.scrollIntoView({ block: "nearest" });
      }
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && button.getAttribute("aria-expanded") === "true") {
        closeOpen();
        button.focus();
      }
    });
    host.append(button, panel);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Parse a fetch response as JSON without throwing on non-JSON bodies.
// Infrastructure-level errors (e.g. Vercel's plain-text 413 "Request Entity
// Too Large") never reach our API code, so response.json() would throw a
// confusing "Unexpected token" error instead of the real status. Returns
// null when the body is not JSON; callers fall back to the HTTP status.
async function parseJsonBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function multiply(a, scalar) {
  return [a[0] * scalar, a[1] * scalar];
}

function magnitude(vector) {
  return Math.hypot(vector[0], vector[1]);
}

function cubicPoint(points, t) {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return [
    b0 * points[0][0] + b1 * points[1][0] + b2 * points[2][0] + b3 * points[3][0],
    b0 * points[0][1] + b1 * points[1][1] + b2 * points[2][1] + b3 * points[3][1],
  ];
}

function cubicDerivative(points, t) {
  const u = 1 - t;
  return [
    3 * u * u * (points[1][0] - points[0][0]) +
      6 * u * t * (points[2][0] - points[1][0]) +
      3 * t * t * (points[3][0] - points[2][0]),
    3 * u * u * (points[1][1] - points[0][1]) +
      6 * u * t * (points[2][1] - points[1][1]) +
      3 * t * t * (points[3][1] - points[2][1]),
  ];
}

function segmentCount(controlPoints, closed) {
  return closed ? controlPoints.length / 3 : (controlPoints.length - 1) / 3;
}

function segmentPoints(controlPoints, closed, segment) {
  const count = controlPoints.length;
  const base = 3 * segment;
  return [
    controlPoints[base % count],
    controlPoints[(base + 1) % count],
    controlPoints[(base + 2) % count],
    controlPoints[(base + 3) % count],
  ];
}

function samplesFromTarget(controlPoints, closed = false, samplesPerSegment = 33) {
  const samples = [];
  const segments = segmentCount(controlPoints, closed);
  for (let segment = 0; segment < segments; segment += 1) {
    const points = segmentPoints(controlPoints, closed, segment);
    for (let index = 0; index < samplesPerSegment; index += 1) {
      const t = index / (samplesPerSegment - 1);
      const point = cubicPoint(points, t);
      const derivative = cubicDerivative(points, t);
      const speed = Math.max(1e-9, magnitude(derivative));
      samples.push({
        segment,
        t,
        point,
        normal: [-derivative[1] / speed, derivative[0] / speed],
        weight: speed / (samplesPerSegment - 1),
      });
    }
  }
  return samples;
}

function makeChain(target, initial, leftRegion, rightRegion, closed = false, samplesPerSegment = 33) {
  return {
    control_points: clone(initial),
    samples: samplesFromTarget(target, closed, samplesPerSegment),
    left_region: leftRegion,
    right_region: rightRegion,
    closed,
  };
}

function straightControls(a, b) {
  const delta = subtract(b, a);
  return [a, add(a, multiply(delta, 1 / 3)), add(a, multiply(delta, 2 / 3)), b];
}

function offsetInterior(points, amount, phase = 0) {
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) {
      return [...point];
    }
    const offset = amount * (0.7 + 0.3 * Math.sin(index * 1.7 + phase));
    return [point[0] + 0.18 * offset * Math.cos(index + phase), point[1] + offset];
  });
}

function wavePreset() {
  const target = [
    [70, 265],
    [110, 185],
    [155, 180],
    [200, 245],
    [245, 315],
    [295, 330],
    [340, 255],
    [385, 175],
    [435, 170],
    [480, 235],
    [525, 305],
    [575, 310],
    [620, 250],
  ];
  return { chains: [makeChain(target, offsetInterior(target, 30, 0.4), 0, 1)] };
}

function junctionPreset() {
  const center = [340, 280];
  const targets = [
    [center, [270, 235], [180, 170], [80, 115]],
    [center, [410, 230], [500, 175], [610, 120]],
    [center, [350, 350], [360, 435], [350, 520]],
  ];
  const chains = targets.map((target, index) => {
    const initial = target.map((point, pointIndex) => {
      if (pointIndex === 0 || pointIndex === 3) {
        return [...point];
      }
      const sign = index === 1 ? -1 : 1;
      return [point[0] + sign * 18, point[1] + (index === 2 ? -20 : 22)];
    });
    return makeChain(target, initial, index, 3, false, 41);
  });
  return { chains };
}

function ringPreset() {
  const cx = 345;
  const cy = 275;
  const radius = 170;
  const k = 0.5522847498307936 * radius;
  const target = [
    [cx + radius, cy],
    [cx + radius, cy + k],
    [cx + k, cy + radius],
    [cx, cy + radius],
    [cx - k, cy + radius],
    [cx - radius, cy + k],
    [cx - radius, cy],
    [cx - radius, cy - k],
    [cx - k, cy - radius],
    [cx, cy - radius],
    [cx + k, cy - radius],
    [cx + radius, cy - k],
  ];
  const initial = target.map((point, index) => {
    const radial = subtract(point, [cx, cy]);
    const factor = 1 + 0.12 * Math.sin(index * 1.35 + 0.3);
    return add([cx, cy], multiply(radial, factor));
  });
  return { chains: [makeChain(target, initial, 0, 1, true, 41)] };
}

function crossingPreset() {
  const first = straightControls([90, 100], [600, 470]);
  const second = straightControls([90, 470], [600, 100]);
  return {
    chains: [makeChain(first, first, 0, 1), makeChain(second, second, 2, 3)],
  };
}

function overlapPreset() {
  const first = straightControls([100, 280], [600, 280]);
  const second = straightControls([100, 280], [390, 280]);
  return {
    chains: [makeChain(first, first, 0, 1), makeChain(second, second, 0, 2)],
  };
}

function reversalPreset() {
  const target = straightControls([150, 280], [540, 280]);
  const initial = [[150, 280], [650, 280], [-80, 280], [540, 280]];
  return { chains: [makeChain(target, initial, 0, 1, false, 49)] };
}

function batchPreset() {
  const chains = [];
  for (let index = 0; index < 256; index += 1) {
    const column = index % 16;
    const row = Math.floor(index / 16);
    const x = 35 + 82 * column;
    const y = 35 + 52 * row;
    const target = [
      [x, y],
      [x + 10, y - 5],
      [x + 20, y - 5],
      [x + 30, y],
      [x + 40, y + 5],
      [x + 50, y + 5],
      [x + 60, y],
    ];
    const initial = target.map((point, pointIndex) => {
      if (pointIndex === 0 || pointIndex === target.length - 1) {
        return [...point];
      }
      return [point[0], point[1] + 4 + 1.5 * Math.sin(pointIndex + index * 0.2)];
    });
    chains.push(makeChain(target, initial, index, index + 256, false, 25));
  }
  return { chains };
}

const presetFactories = {
  wave: wavePreset,
  junction: junctionPreset,
  ring: ringPreset,
  crossing: crossingPreset,
  overlap: overlapPreset,
  reversal: reversalPreset,
  batch: batchPreset,
};

function chooseGridStep() {
  const raw = 70 / state.view.scale;
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const normalized = raw / power;
  const multiplierValue = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplierValue * power;
}

function toScreen(point) {
  return [
    point[0] * state.view.scale + state.view.offsetX,
    point[1] * state.view.scale + state.view.offsetY,
  ];
}

function toWorld(x, y) {
  return [
    (x - state.view.offsetX) / state.view.scale,
    (y - state.view.offsetY) / state.view.scale,
  ];
}

function drawGrid() {
  const step = chooseGridStep();
  const left = -state.view.offsetX / state.view.scale;
  const right = (state.canvasWidth - state.view.offsetX) / state.view.scale;
  const top = -state.view.offsetY / state.view.scale;
  const bottom = (state.canvasHeight - state.view.offsetY) / state.view.scale;
  context.save();
  context.lineWidth = 1;
  context.strokeStyle = "rgba(84, 102, 119, 0.13)";
  context.beginPath();
  for (let x = Math.floor(left / step) * step; x <= right; x += step) {
    const screen = toScreen([x, 0])[0];
    context.moveTo(Math.round(screen) + 0.5, 0);
    context.lineTo(Math.round(screen) + 0.5, state.canvasHeight);
  }
  for (let y = Math.floor(top / step) * step; y <= bottom; y += step) {
    const screen = toScreen([0, y])[1];
    context.moveTo(0, Math.round(screen) + 0.5);
    context.lineTo(state.canvasWidth, Math.round(screen) + 0.5);
  }
  context.stroke();
  context.restore();
}

function drawRasterOverlay(alpha = Number($("overlay-opacity").value)) {
  if (!state.overlayImage) {
    return;
  }
  const origin = toScreen([0, 0]);
  const width = state.overlayImage.naturalWidth * state.view.scale;
  const height = state.overlayImage.naturalHeight * state.view.scale;
  context.save();
  context.globalAlpha = alpha;
  context.imageSmoothingEnabled = true;
  // Same white ground the segmenter is given, so the preview does not show a
  // transparent image over the dark page while the engine sees it over white.
  context.fillStyle = "#ffffff";
  context.fillRect(origin[0], origin[1], width, height);
  context.drawImage(state.overlayImage, origin[0], origin[1], width, height);
  context.restore();
}

function drawRasterCanvas(source, alpha = 1) {
  if (!state.discrete || !source) {
    return;
  }
  const origin = toScreen([0, 0]);
  const width = state.discrete.sourceWidth * state.view.scale;
  const height = state.discrete.sourceHeight * state.view.scale;
  context.save();
  context.globalAlpha = alpha;
  context.imageSmoothingEnabled = false;
  context.drawImage(source, origin[0], origin[1], width, height);
  context.restore();
}

function drawRagOverlay() {
  if (!state.discrete) {
    return;
  }
  const scaleX = state.discrete.sourceWidth / state.discrete.width;
  const scaleY = state.discrete.sourceHeight / state.discrete.height;
  const stride = Math.max(1, Math.ceil(state.discrete.edges.length / 8000));
  context.save();
  context.strokeStyle = "rgba(107, 167, 255, 0.68)";
  context.fillStyle = "rgba(85, 228, 220, 0.88)";
  context.lineWidth = 1.25;
  context.beginPath();
  for (let index = 0; index < state.discrete.edges.length; index += stride) {
    const edge = state.discrete.edges[index];
    const left = state.discrete.regions[edge.left]?.centroid;
    const right = state.discrete.regions[edge.right]?.centroid;
    if (!left || !right) {
      continue;
    }
    const a = toScreen([left[0] * scaleX, left[1] * scaleY]);
    const b = toScreen([right[0] * scaleX, right[1] * scaleY]);
    context.moveTo(a[0], a[1]);
    context.lineTo(b[0], b[1]);
  }
  context.stroke();
  for (const region of state.discrete.regions) {
    const point = toScreen([region.centroid[0] * scaleX, region.centroid[1] * scaleY]);
    context.beginPath();
    context.arc(point[0], point[1], 2.25, 0, 2 * Math.PI);
    context.fill();
  }
  context.restore();
}

function drawLabelBoundary() {
  const boundary = state.discrete?.labelBoundary;
  if (!$("display-label-boundary").checked || !boundary?.segments) {
    return;
  }
  const scaleX = state.discrete.sourceWidth / state.discrete.width;
  const scaleY = state.discrete.sourceHeight / state.discrete.height;
  const values = boundary.segments;
  context.save();
  context.strokeStyle = "rgba(107, 167, 255, 0.72)";
  context.lineWidth = 1.15;
  context.beginPath();
  for (let index = 0; index < values.length; index += 4) {
    context.moveTo(
      values[index] * scaleX * state.view.scale + state.view.offsetX,
      values[index + 1] * scaleY * state.view.scale + state.view.offsetY,
    );
    context.lineTo(
      values[index + 2] * scaleX * state.view.scale + state.view.offsetX,
      values[index + 3] * scaleY * state.view.scale + state.view.offsetY,
    );
  }
  context.stroke();
  context.restore();
}

const MAX_VISIBLE_EVIDENCE_SEGMENTS = 500000;

function evidenceContours() {
  if (state.inputMode === "raster" && state.discrete?.evidenceContours) {
    return state.discrete.evidenceContours;
  }
  return state.problem?.chains.map((chain) => chain.source_points || []) || [];
}

function drawEvidenceContours() {
  if (!$("display-evidence").checked) {
    return;
  }
  const contours = evidenceContours();
  const totalSegments = contours.reduce(
    (sum, points) => sum + Math.max(0, points.length - 1),
    0,
  );
  if (totalSegments === 0) {
    return;
  }
  const stride = Math.max(
    1,
    Math.ceil(totalSegments / MAX_VISIBLE_EVIDENCE_SEGMENTS),
  );
  context.save();
  context.strokeStyle = "rgba(85, 228, 220, 0.82)";
  context.lineWidth = 1.35;
  context.beginPath();
  for (const points of contours) {
    if (stride === 1 && points.length > 0) {
      const first = toScreen(points[0]);
      context.moveTo(first[0], first[1]);
      for (let index = 1; index < points.length; ++index) {
        const point = toScreen(points[index]);
        context.lineTo(point[0], point[1]);
      }
      continue;
    }
    for (let index = 0; index + 1 < points.length; index += stride) {
      const first = toScreen(points[index]);
      const second = toScreen(points[index + 1]);
      context.moveTo(first[0], first[1]);
      context.lineTo(second[0], second[1]);
    }
  }
  context.stroke();
  context.restore();
}

function flaggedTargetSamples(chain) {
  const flags = new Set();
  const parameterEpsilon = 1e-9;
  const segments = segmentCount(chain.control_points, chain.closed);
  let previous = null;
  chain.samples.forEach((sample, index) => {
    const invalidSegment = sample.segment < 0 || sample.segment >= segments;
    let largeResidual = false;
    if (!invalidSegment) {
      const assigned = cubicPoint(
        segmentPoints(chain.control_points, chain.closed, sample.segment),
        sample.t,
      );
      largeResidual = Math.hypot(
        assigned[0] - sample.point[0],
        assigned[1] - sample.point[1],
      ) > 1;
    }
    if (invalidSegment || largeResidual ||
        sample.t <= parameterEpsilon || sample.t >= 1 - parameterEpsilon) {
      flags.add(index);
    }
    if (previous &&
        (sample.segment < previous.sample.segment ||
         (sample.segment === previous.sample.segment &&
          sample.t <= previous.sample.t + parameterEpsilon))) {
      flags.add(previous.index);
      flags.add(index);
    }
    previous = { sample, index };
  });
  return flags;
}

function drawTargetSamples(controlSets = null) {
  if (!$("display-targets").checked || !state.problem) {
    return;
  }
  const totalSamples = state.problem.chains.reduce((sum, chain) => sum + chain.samples.length, 0);
  const pointStride = Math.max(1, Math.ceil(totalSamples / 3500));
  const normalStride = Math.max(1, Math.ceil(totalSamples / 320));
  const assignmentStride = Math.max(1, Math.ceil(totalSamples / 1200));
  const showAssignments = $("display-assignments").checked && controlSets;
  context.save();
  for (let chainIndex = 0; chainIndex < state.problem.chains.length; chainIndex += 1) {
    const chain = state.problem.chains[chainIndex];
    const flags = flaggedTargetSamples(chain);
    if (showAssignments) {
      const controls = controlSets[chainIndex];
      const segments = segmentCount(controls, chain.closed);
      context.lineWidth = 1;
      context.strokeStyle = "rgba(85, 228, 220, 0.28)";
      context.beginPath();
      chain.samples.forEach((sample, index) => {
        if (index % assignmentStride !== 0 || flags.has(index) ||
            sample.segment < 0 || sample.segment >= segments) {
          return;
        }
        const target = toScreen(sample.point);
        const assigned = toScreen(cubicPoint(
          segmentPoints(controls, chain.closed, sample.segment),
          sample.t,
        ));
        context.moveTo(target[0], target[1]);
        context.lineTo(assigned[0], assigned[1]);
      });
      context.stroke();

      context.strokeStyle = "rgba(255, 107, 113, 0.82)";
      context.beginPath();
      chain.samples.forEach((sample, index) => {
        if (!flags.has(index) || sample.segment < 0 || sample.segment >= segments) {
          return;
        }
        const target = toScreen(sample.point);
        const assigned = toScreen(cubicPoint(
          segmentPoints(controls, chain.closed, sample.segment),
          sample.t,
        ));
        context.moveTo(target[0], target[1]);
        context.lineTo(assigned[0], assigned[1]);
      });
      context.stroke();
    }

    context.strokeStyle = "rgba(85, 228, 220, 0.66)";
    context.lineWidth = 1.35;
    context.beginPath();
    chain.samples.forEach((sample, index) => {
      if ($("display-normals").checked && index % normalStride === 0) {
        const [x, y] = toScreen(sample.point);
        context.moveTo(x, y);
        context.lineTo(x + 10 * sample.normal[0], y + 10 * sample.normal[1]);
      }
    });
    context.stroke();

    chain.samples.forEach((sample, index) => {
      if (index % pointStride !== 0 && !flags.has(index)) {
        return;
      }
      const [x, y] = toScreen(sample.point);
      context.beginPath();
      context.arc(x, y, flags.has(index) ? 2.4 : 1.65, 0, 2 * Math.PI);
      context.fillStyle = flags.has(index)
        ? "rgba(255, 107, 113, 0.96)"
        : "rgba(85, 228, 220, 0.82)";
      context.fill();
    });
  }
  context.restore();
}

function drawCurveSet(controlSets, mode) {
  if (!state.problem || !controlSets) {
    return;
  }
  context.save();
  context.lineWidth = mode === "optimized" ? 2.4 : 1.55;
  context.setLineDash(mode === "optimized" ? [] : [7, 5]);
  context.globalAlpha = mode === "optimized" ? 0.96 : 0.75;
  for (let chainIndex = 0; chainIndex < state.problem.chains.length; chainIndex += 1) {
    const chain = state.problem.chains[chainIndex];
    const controls = controlSets[chainIndex];
    const segments = segmentCount(controls, chain.closed);
    if (mode === "optimized" && state.problem.chains.length > 8) {
      context.strokeStyle = `hsl(${165 + (chainIndex % 11) * 2} 72% 67%)`;
    } else {
      context.strokeStyle = mode === "optimized" ? "#b8f57a" : "#ffb85c";
    }
    context.beginPath();
    for (let segment = 0; segment < segments; segment += 1) {
      const points = segmentPoints(controls, chain.closed, segment).map(toScreen);
      if (segment === 0) {
        context.moveTo(points[0][0], points[0][1]);
      }
      context.bezierCurveTo(
        points[1][0],
        points[1][1],
        points[2][0],
        points[2][1],
        points[3][0],
        points[3][1],
      );
    }
    context.stroke();
  }
  context.restore();
}

function drawControls() {
  if (!$("display-controls").checked || !state.problem) {
    return;
  }
  context.save();
  context.lineWidth = 1;
  context.strokeStyle = "rgba(107, 167, 255, 0.34)";
  context.fillStyle = "#6ba7ff";
  for (let chainIndex = 0; chainIndex < state.problem.chains.length; chainIndex += 1) {
    const chain = state.problem.chains[chainIndex];
    const controls = chain.control_points;
    const segments = segmentCount(controls, chain.closed);
    for (let segment = 0; segment < segments; segment += 1) {
      const points = segmentPoints(controls, chain.closed, segment).map(toScreen);
      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      context.lineTo(points[1][0], points[1][1]);
      context.moveTo(points[2][0], points[2][1]);
      context.lineTo(points[3][0], points[3][1]);
      context.stroke();
    }
    controls.forEach((point, pointIndex) => {
      const [x, y] = toScreen(point);
      const isKnot = pointIndex % 3 === 0;
      const hovered = state.hover &&
        state.hover.chain === chainIndex &&
        state.hover.point === pointIndex;
      context.beginPath();
      if (isKnot) {
        const size = hovered ? 7 : 5;
        context.rect(x - size / 2, y - size / 2, size, size);
      } else {
        context.arc(x, y, hovered ? 4.5 : 3.2, 0, 2 * Math.PI);
      }
      context.fillStyle = hovered ? "#edf5f5" : isKnot ? "#55e4dc" : "#6ba7ff";
      context.fill();
    });
  }
  context.restore();
}

function drawFlatSvgPreview() {
  const image = state.svgPreview?.image;
  if (!image || !state.discrete) {
    return;
  }
  const origin = toScreen([0, 0]);
  const width = state.discrete.sourceWidth * state.view.scale;
  const height = state.discrete.sourceHeight * state.view.scale;
  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#ffffff";
  context.fillRect(origin[0], origin[1], width, height);
  context.drawImage(image, origin[0], origin[1], width, height);
  context.restore();
}

function draw() {
  const ratio = window.devicePixelRatio || 1;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, state.canvasWidth, state.canvasHeight);
  if (state.inputMode === "raster") {
    if (state.preview === "source") {
      drawRasterOverlay(1);
    } else if (state.preview === "regions") {
      drawRasterCanvas(state.discrete?.flatCanvas);
    } else if (state.preview === "boundaries") {
      drawRasterCanvas(state.discrete?.flatCanvas, 0.92);
      drawRasterCanvas(state.discrete?.boundaryCanvas);
    } else if (state.preview === "rag") {
      drawRasterCanvas(state.discrete?.flatCanvas, 0.68);
      drawRagOverlay();
    } else if (state.preview === "initial") {
      drawRasterOverlay();
      drawLabelBoundary();
      drawEvidenceContours();
      if (state.problem) {
        const initialControls = state.problem.chains.map((chain) => chain.control_points);
        drawTargetSamples(initialControls);
        drawCurveSet(initialControls, "initial");
      }
      drawControls();
    } else if (state.preview === "initial-fill") {
      drawRasterCanvas(state.reference?.initial?.canvas);
    } else if (state.preview === "optimized") {
      drawRasterOverlay();
      drawLabelBoundary();
      drawEvidenceContours();
      drawTargetSamples();
      if ($("display-initial").checked && state.problem) {
        drawCurveSet(state.problem.chains.map((chain) => chain.control_points), "initial");
      }
      if (state.optimized) {
        drawCurveSet(state.optimized, "optimized");
      }
    } else if (state.preview === "optimized-fill") {
      drawRasterCanvas(state.reference?.optimized?.canvas);
    } else if (state.preview === "flat-svg") {
      drawFlatSvgPreview();
    }
  } else {
    drawGrid();
    drawEvidenceContours();
    drawTargetSamples(state.problem?.chains.map((chain) => chain.control_points));
    if ($("display-initial").checked && state.problem) {
      drawCurveSet(state.problem.chains.map((chain) => chain.control_points), "initial");
    }
    if (state.optimized) {
      drawCurveSet(state.optimized, "optimized");
    }
    drawControls();
  }
  updateCanvasChrome();
}

function updateCanvasChrome() {
  const raster = state.inputMode === "raster";
  const curveStage = !raster || state.preview === "initial" || state.preview === "optimized";
  const empty = raster && !state.overlayImage;
  $("canvas-empty").hidden = !empty;
  $("canvas-legend").hidden = empty || (!curveStage && state.preview !== "boundaries" && state.preview !== "rag");
  document.querySelector("[data-legend='target']").hidden =
    !curveStage || !$("display-targets").checked;
  document.querySelector("[data-legend='evidence']").hidden =
    !curveStage || !$("display-evidence").checked ||
    !evidenceContours().some((points) => points.length > 1);
  document.querySelector("[data-legend='label-boundary']").hidden =
    !raster || !curveStage || !$("display-label-boundary").checked ||
    !state.discrete?.labelBoundary?.segments;
  document.querySelector("[data-legend='initial']").hidden = !curveStage;
  document.querySelector("[data-legend='result']").hidden = !state.optimized || state.preview === "initial";
  document.querySelector("[data-legend='discrete']").hidden = !raster || !["boundaries", "rag"].includes(state.preview);
  const editable = !raster || state.preview === "initial";
  $("canvas-help").textContent = editable
    ? "Drag control points · wheel to zoom · drag empty space to pan"
    : "Wheel to zoom · drag to pan · double-click to fit";
}

function resizeCanvas() {
  const rectangle = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  state.canvasWidth = Math.max(1, rectangle.width);
  state.canvasHeight = Math.max(1, rectangle.height);
  const width = Math.round(state.canvasWidth * ratio);
  const height = Math.round(state.canvasHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  draw();
}

function problemBounds() {
  const points = [];
  if (state.problem) {
    for (const chain of state.problem.chains) {
      points.push(...chain.control_points);
      for (const sample of chain.samples) {
        points.push(sample.point);
      }
    }
  }
  for (const contour of evidenceContours()) {
    points.push(...contour);
  }
  if (state.optimized) {
    for (const controls of state.optimized) {
      points.push(...controls);
    }
  }
  if (state.inputMode === "raster" && state.overlayImage) {
    points.push([0, 0], [state.overlayImage.naturalWidth, state.overlayImage.naturalHeight]);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  return { minX, minY, maxX, maxY };
}

function fitView() {
  if ((!state.problem && !(state.inputMode === "raster" && state.overlayImage)) ||
      state.canvasWidth <= 1 || state.canvasHeight <= 1) {
    return;
  }
  const bounds = problemBounds();
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const padding = 58;
  state.view.scale = Math.min(
    (state.canvasWidth - 2 * padding) / width,
    (state.canvasHeight - 2 * padding) / height,
  );
  state.view.scale = Math.max(0.02, Math.min(30, state.view.scale));
  state.view.offsetX =
    (state.canvasWidth - state.view.scale * (bounds.minX + bounds.maxX)) / 2;
  state.view.offsetY =
    (state.canvasHeight - state.view.scale * (bounds.minY + bounds.maxY)) / 2;
  draw();
}

function countProblem() {
  if (!state.problem) {
    return { chains: 0, cubics: 0, controls: 0, samples: 0 };
  }
  return state.problem.chains.reduce(
    (count, chain) => ({
      chains: count.chains + 1,
      cubics: count.cubics + segmentCount(chain.control_points, chain.closed),
      controls: count.controls + chain.control_points.length,
      samples: count.samples + chain.samples.length,
    }),
    { chains: 0, cubics: 0, controls: 0, samples: 0 },
  );
}

function compactNumber(value) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

function metricNumber(value, digits = 3) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (Math.abs(value) >= 10000 || (Math.abs(value) > 0 && Math.abs(value) < 0.001)) {
    return value.toExponential(2);
  }
  return value.toFixed(digits);
}

function diagnosticRange(summary) {
  if (!summary || !Number.isFinite(summary.p95_px) || !Number.isFinite(summary.max_px)) {
    return "—";
  }
  return `${metricNumber(summary.p95_px, 3)}/${metricNumber(summary.max_px, 3)} px`;
}

function renderTargetDiagnostics() {
  const output = $("target-diagnostics-summary");
  output.hidden = state.inputMode !== "raster";
  if (output.hidden) {
    return;
  }
  const diagnostics = state.discrete?.targetDiagnostics;
  if (!diagnostics) {
    output.dataset.state = "idle";
    output.textContent = state.discrete
      ? "Fit curves to measure target coverage and cubic correspondence."
      : "Run the discrete stage to expose the exact connected label boundary.";
    return;
  }
  const orderingFailures = diagnostics.collapsed_distinct_parameters +
    diagnostics.reversed_parameters + diagnostics.segment_order_reversals;
  const structuralFailures = orderingFailures + diagnostics.invalid_segments +
    diagnostics.empty_segments + diagnostics.assignment_euclidean_over_1px;
  output.dataset.state = structuralFailures > 0 ? "warning" : "success";
  output.textContent =
    `${compactNumber(state.discrete.fitReport.raster_boundary_edges)} label-grid edges → ` +
    `${compactNumber(diagnostics.sample_count)} target dots · ` +
    `${compactNumber(diagnostics.clamped_parameters)} t-clamped · ` +
    `${compactNumber(diagnostics.collapsed_distinct_parameters)} distinct t-collapses · ` +
    `${compactNumber(diagnostics.reversed_parameters + diagnostics.segment_order_reversals)} reversals · ` +
    `${compactNumber(diagnostics.assignment_euclidean_over_1px)} assignments >1 px · ` +
    `bin-join gap p95/max ${diagnosticRange(diagnostics.target_join_gap)} · ` +
    `knot gap p95/max ${diagnosticRange(diagnostics.knot_sample_gap)} · ` +
    `assigned distance p95/max ${diagnosticRange(diagnostics.assignment_euclidean_residual)} · ` +
    `assigned normal error p95/max ${diagnosticRange(diagnostics.assignment_normal_residual)}`;
}

function statusLabel(value) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderMetrics() {
  const count = countProblem();
  $("metric-size").textContent = `${compactNumber(count.cubics)} cubic${count.cubics === 1 ? "" : "s"}`;
  $("metric-evaluations").textContent = `${compactNumber(count.chains)} chains · ${compactNumber(count.samples)} targets`;
  const card = document.querySelector(".status-card");
  const initialRaster = state.reference?.initial?.report;
  const optimizedRaster = state.reference?.optimized?.report;
  const psnrText = (report) => {
    if (!report) {
      return "—";
    }
    return report.psnr_db === null
      ? "∞ dB"
      : `${metricNumber(report.psnr_db, 2)} dB`;
  };
  $("metric-raster").textContent = psnrText(optimizedRaster || initialRaster);
  $("metric-raster-delta").textContent = optimizedRaster
    ? `${psnrText(initialRaster)} → ${psnrText(optimizedRaster)}`
    : initialRaster
      ? `Initializer · ${metricNumber(initialRaster.yang_data_energy, 4)} Yang data`
      : "Render the reference fills";
  if (!state.report) {
    card.dataset.status = "idle";
    $("metric-status").textContent = "Ready";
    $("metric-status-detail").textContent = "Edit controls or run the native optimizer.";
    $("metric-time").textContent = "—";
    $("metric-round-trip").textContent = "Round trip —";
    $("metric-rmse").textContent = "—";
    $("metric-rmse-delta").textContent = "Before → after";
    $("metric-energy").textContent = "—";
    $("metric-energy-delta").textContent = "Before → after";
    return;
  }
  const report = state.report;
  const rasterReport = state.rasterReport;
  const success = report.status === 0;
  card.dataset.status = success ? "success" : "error";
  $("metric-status").textContent = statusLabel(report.status_text);
  $("metric-status-detail").textContent = success
    ? `${report.sweeps} boundary sweeps` +
      (rasterReport ? ` · ${rasterReport.sweeps} filled-RGB sweeps` : "") +
      (rasterReport?.color_solves
        ? ` · ${rasterReport.color_solves} color solves`
        : "") +
      ` · ${report.topology_rejections + (rasterReport?.topology_rejections || 0)} topology retries`
    : report.status === 2
      ? "Initializer rejected before optimization."
      : "The last topology-valid geometry was retained.";
  const nativeTime = report.elapsed_ms + (rasterReport?.elapsed_ms || 0);
  $("metric-time").textContent = `${metricNumber(nativeTime, nativeTime < 1 ? 3 : 2)} ms`;
  $("metric-round-trip").textContent = `Round trip ${metricNumber(state.response.round_trip_ms, 2)} ms`;
  $("metric-rmse").textContent = `${metricNumber(report.final_normal_rmse_px)} px`;
  $("metric-rmse-delta").textContent = `${metricNumber(report.initial_normal_rmse_px)} → ${metricNumber(report.final_normal_rmse_px)} px`;
  $("metric-energy").textContent = metricNumber(
    rasterReport?.final_objective ?? report.final_energy,
  );
  $("metric-energy-delta").textContent = rasterReport
    ? `${metricNumber(rasterReport.initial_objective)} → ` +
      `${metricNumber(rasterReport.final_objective)} joint objective`
    : `${metricNumber(report.initial_energy)} → ${metricNumber(report.final_energy)}`;
  const usesSolvedColors = (rasterReport?.color_solves || 0) > 0;
  $("metric-evaluations").textContent = rasterReport
    ? `${compactNumber(report.sample_evaluations)} sample evals · ${compactNumber(rasterReport.active_pixels)} active px` +
      (usesSolvedColors
        ? ` · ${compactNumber(rasterReport.color_solve_iterations)} color iterations`
        : "")
    : `${compactNumber(report.sample_evaluations)} sample evals · ${compactNumber(count.samples)} targets`;
}

function resetExportSvgSummary() {
  $("export-svg-summary").dataset.state = "idle";
  $("export-svg-summary").textContent =
    "Optimize first, then export a filled SVG in source pixel coordinates.";
}

function clearFlatSvgPreview() {
  if (state.svgPreview?.url) {
    URL.revokeObjectURL(state.svgPreview.url);
  }
  state.svgPreview = null;
}

function logRun(message) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const text = document.createElement("span");
  text.textContent = message;
  item.append(time, text);
  const list = $("run-log-list");
  list.prepend(item);
  while (list.children.length > 8) {
    list.lastElementChild.remove();
  }
}

function captureSession() {
  return {
    problem: state.problem,
    baseline: state.baseline,
    optimized: state.optimized,
    report: state.report,
    response: state.response,
    reference: state.reference,
    rasterReport: state.rasterReport,
    preset: state.preset,
    hover: state.hover,
  };
}

function restoreSession(session) {
  state.problem = session?.problem || null;
  state.baseline = session?.baseline || null;
  state.optimized = session?.optimized || null;
  state.report = session?.report || null;
  state.response = session?.response || null;
  state.reference = session?.reference || null;
  state.rasterReport = session?.rasterReport || null;
  state.preset = session?.preset || (state.inputMode === "fixture" ? $("preset-select").value : "fitted-raster");
  state.hover = session?.hover || null;
}

function previewAvailable(name) {
  if (name === "source") {
    return Boolean(state.overlayImage);
  }
  if (["regions", "boundaries", "rag"].includes(name)) {
    return Boolean(state.discrete);
  }
  if (name === "initial") {
    return Boolean(state.problem);
  }
  if (name === "initial-fill") {
    return Boolean(state.reference?.initial?.canvas);
  }
  if (name === "optimized") {
    return Boolean(state.optimized);
  }
  if (name === "optimized-fill") {
    return Boolean(state.reference?.optimized?.canvas);
  }
  if (name === "flat-svg") {
    return Boolean(state.svgPreview?.image);
  }
  return name === "fixture" && state.inputMode === "fixture";
}

function refreshRasterPreviewTabs() {
  for (const tab of document.querySelectorAll("#raster-preview-tabs [data-preview]")) {
    tab.disabled = !previewAvailable(tab.dataset.preview);
    const active = state.inputMode === "raster" && tab.dataset.preview === state.preview;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  if (state.inputMode === "raster" && !previewAvailable(state.preview)) {
    const fallback = [...rasterPreviewOrder].reverse().find(previewAvailable);
    state.preview = fallback || "source";
    if (fallback) {
      refreshRasterPreviewTabs();
      return;
    }
  }
  const descriptionsByStage = {
    source: state.overlayImage ? `${state.overlayImage.naturalWidth}×${state.overlayImage.naturalHeight} source pixels` : "No raster loaded",
    regions: state.discrete ? `${compactNumber(state.discrete.report.final_regions)} mean-sRGB regions · no borders` : "Run discrete first",
    boundaries: state.discrete ? `${compactNumber(state.discrete.report.rag_edges)} shared RAG adjacencies` : "Run discrete first",
    rag: state.discrete ? `${compactNumber(state.discrete.edges.length)} centroid links` : "Run discrete first",
    initial: state.problem ? `${compactNumber(countProblem().cubics)} topology-safe fitted cubics` : "Fit curves first",
    "initial-fill": state.reference?.initial
      ? `${state.reference.initial.report.psnr_db === null ? "∞" : metricNumber(state.reference.initial.report.psnr_db, 2)} dB · full filled RGB initializer`
      : "Render filled stages first",
    optimized: state.report
      ? `${statusLabel(state.report.status_text)} · ${metricNumber(state.report.final_normal_rmse_px)} px target RMSE` +
        (state.rasterReport
          ? ` · ${state.rasterReport.sweeps} filled-RGB sweeps`
          : "") +
        (state.rasterReport?.color_solves
          ? ` · ${state.rasterReport.color_solves} color solves`
          : "")
      : "Optimize first",
    "optimized-fill": state.reference?.optimized
      ? `${state.reference.optimized.report.psnr_db === null ? "∞" : metricNumber(state.reference.optimized.report.psnr_db, 2)} dB · fixed-l₀ Yang data ${metricNumber(state.reference.optimized.report.yang_data_energy, 4)}`
      : "Optimize and render filled stages first",
    "flat-svg": state.svgPreview
      ? `${state.svgPreview.regionCount} flat region${state.svgPreview.regionCount === 1 ? "" : "s"} · ` +
        `${state.svgPreview.width}×${state.svgPreview.height} source px · ` +
        `${compactNumber(state.svgPreview.loopCount)} boundary loop${state.svgPreview.loopCount === 1 ? "" : "s"}`
      : "Optimize first to build the native flat SVG preview",
  };
  if (state.inputMode === "raster") {
    $("preview-status").textContent = descriptionsByStage[state.preview] || "Raster pipeline";
  }
}

function setPreview(name, fit = false) {
  if (state.inputMode === "fixture") {
    state.preview = "fixture";
  } else if (previewAvailable(name)) {
    state.preview = name;
  } else {
    return;
  }
  refreshRasterPreviewTabs();
  if (fit) {
    requestAnimationFrame(fitView);
  } else {
    draw();
  }
}

function refreshPreviewAfterStage(fallback) {
  if (state.inputMode === "fixture") {
    state.preview = "fixture";
    refreshRasterPreviewTabs();
    draw();
    return;
  }
  if (!previewAvailable(state.preview)) {
    if (fallback && previewAvailable(fallback)) {
      state.preview = fallback;
    } else {
      const next = [...rasterPreviewOrder].reverse().find(previewAvailable);
      state.preview = next || "source";
    }
  }
  refreshRasterPreviewTabs();
  draw();
}

function syncPipelineActions() {
  const raster = state.inputMode === "raster";
  $("reset-button").disabled = !state.problem;
  $("run-button").disabled = state.running || !state.problem;
  $("render-reference-button").disabled =
    state.rendering || !raster || !state.problem;
  $("export-svg-button").disabled =
    state.exportingSvg || !state.optimized || !state.discrete || !state.problem;
}

function syncModeUi() {
  const raster = state.inputMode === "raster";
  for (const button of document.querySelectorAll("[data-input-mode]")) {
    const active = button.dataset.inputMode === state.inputMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  $("fixture-toolbar").hidden = raster;
  $("raster-toolbar").hidden = !raster;
  $("fixture-preview-tabs").hidden = raster;
  $("raster-preview-tabs").hidden = !raster;
  $("raster-controls").hidden = !raster;
  $("yang-target-controls").hidden = !raster;
  $("raster-refinement-controls").hidden = !raster;
  $("raster-reference-controls").hidden = !raster;
  $("export-svg-controls").hidden = !raster;
  $("fixture-controls").hidden = raster;
  syncPipelineActions();
  if (!raster) {
    state.preview = "fixture";
    $("preview-status").textContent = "Synthetic optimizer fixture";
  }
  renderTargetDiagnostics();
  refreshRasterPreviewTabs();
  renderMetrics();
  draw();
}

function setInputMode(mode) {
  if (!['fixture', 'raster'].includes(mode) || mode === state.inputMode) {
    syncModeUi();
    return;
  }
  state.sessions[state.inputMode] = captureSession();
  state.inputMode = mode;
  restoreSession(state.sessions[mode]);
  state.preview = mode === "fixture"
    ? "fixture"
    : state.reference?.optimized
      ? "optimized-fill"
      : state.optimized
        ? "optimized"
        : state.reference?.initial
          ? "initial-fill"
          : state.problem
            ? "initial"
            : state.discrete
              ? "regions"
              : "source";
  syncModeUi();
  requestAnimationFrame(fitView);
}

function setPreset(name) {
  if (state.inputMode !== "fixture") {
    setInputMode("fixture");
  }
  state.preset = name;
  state.problem = presetFactories[name]();
  state.baseline = clone(state.problem);
  state.optimized = null;
  state.reference = null;
  state.rasterReport = null;
  state.report = null;
  state.response = null;
  state.hover = null;
  state.preview = "fixture";
  $("preset-description").textContent = descriptions[name];
  state.sessions.fixture = captureSession();
  renderMetrics();
  syncModeUi();
  requestAnimationFrame(fitView);
  logRun(`Loaded ${$("preset-select").selectedOptions[0].textContent}.`);
}

function numericValue(id, integer = false) {
  const value = Number($(id).value);
  return integer ? Math.trunc(value) : value;
}

function coordinateScale() {
  if (state.inputMode !== "raster" || !state.discrete) {
    return 1;
  }
  const pixels = state.discrete.sourceWidth * state.discrete.sourceHeight;
  return Math.max(1, Math.sqrt(pixels / REFERENCE_OPTIMIZATION_PIXELS));
}

function collectOptions() {
  return {
    max_sweeps: numericValue("max-sweeps", true),
    local_iterations: numericValue("local-iterations", true),
    lbfgs_history: numericValue("lbfgs-history", true),
    coarse_sample_stride: numericValue("coarse-stride", true),
    threads: numericValue("threads", true),
    normalization: $("normalization").value,
    coordinate_scale: coordinateScale(),
    data_weight: numericValue("data-weight"),
    tangent_weight: numericValue("tangent-weight"),
    robust_delta_px: numericValue("robust-delta"),
    angle_weight: numericValue("angle-weight"),
    handle_weight: numericValue("handle-weight"),
    length_weight: numericValue("length-weight"),
    angle_epsilon_rad: numericValue("angle-epsilon"),
    handle_epsilon_px: numericValue("handle-epsilon"),
    max_step_px: numericValue("max-step"),
    gradient_tolerance: numericValue("gradient-tolerance"),
    relative_tolerance: numericValue("relative-tolerance"),
    max_line_search_steps: numericValue("line-search-steps", true),
    reproject_samples: $("reproject-samples").checked,
    projection_iterations: numericValue("projection-iterations", true),
    preserve_topology: $("preserve-topology").checked,
    topology_retries: numericValue("optimizer-topology-retries", true),
    topology_flatness_px: numericValue("topology-flatness"),
    topology_cell_size_px: numericValue("topology-cell-size"),
  };
}

function applyOptions(options) {
  state.suppressLiveRebuild = true;
  try {
    const values = {
      "max-sweeps": options.max_sweeps,
      "local-iterations": options.local_iterations,
      "lbfgs-history": options.lbfgs_history,
      "coarse-stride": options.coarse_sample_stride,
      threads: options.threads,
      normalization: options.normalization,
      "data-weight": options.data_weight,
      "tangent-weight": options.tangent_weight,
      "robust-delta": options.robust_delta_px,
      "angle-weight": options.angle_weight,
      "handle-weight": options.handle_weight,
      "length-weight": options.length_weight,
      "angle-epsilon": options.angle_epsilon_rad,
      "handle-epsilon": options.handle_epsilon_px,
      "max-step": options.max_step_px,
      "gradient-tolerance": options.gradient_tolerance,
      "relative-tolerance": options.relative_tolerance,
      "line-search-steps": options.max_line_search_steps,
      "projection-iterations": options.projection_iterations,
      "optimizer-topology-retries": options.topology_retries,
      "topology-flatness": options.topology_flatness_px,
      "topology-cell-size": options.topology_cell_size_px,
    };
    for (const [id, value] of Object.entries(values)) {
      if (value !== undefined) {
        $(id).value = String(value);
      }
    }
    if (options.reproject_samples !== undefined) {
      $("reproject-samples").checked = Boolean(options.reproject_samples);
    }
    if (options.preserve_topology !== undefined) {
      $("preserve-topology").checked = Boolean(options.preserve_topology);
    }
  } finally {
    state.suppressLiveRebuild = false;
  }
}

function applyPreprocessorOptions(options) {
  state.suppressLiveRebuild = true;
  try {
    const values = {
      "preprocess-target": options.target_regions,
      "preprocess-criterion": options.criterion,
      "preprocess-iterations": options.iterations,
      "preprocess-area-exponent": options.area_exponent,
      "preprocess-smallness": options.area_smallness_scale,
      "preprocess-raster-bias": options.area_raster_bias,
      "preprocess-saliency": options.saliency_weight,
      "preprocess-topology": options.topology_weight,
    };
    for (const [id, value] of Object.entries(values)) {
      if (value !== undefined) {
        $(id).value = String(value);
      }
    }
  } finally {
    state.suppressLiveRebuild = false;
  }
}

function applyFitterOptions(options) {
  state.suppressLiveRebuild = true;
  try {
    const values = {
      "fit-error": options.max_error_px,
      "fit-residual-sigmas": options.residual_sigmas,
      "fit-samples": options.samples_per_cubic,
      "fit-reparameterization": options.reparameterization_iterations,
      "fit-corner-angle": options.corner_angle_degrees,
      "fit-corner-window": options.corner_window,
      "fit-corner-run": options.corner_run_edges,
      "fit-corner-octaves": options.corner_scale_octaves,
      "fit-corner-growth": options.corner_scale_growth,
      "fit-guide-smoothing": options.guide_smoothing,
      "fit-topology-retries": options.topology_retries,
      "fit-subpixel-bound": options.max_subpixel_offset_px,
      "fit-subpixel-anchor": options.subpixel_anchor_weight,
      "fit-max-cubics-chain": options.max_cubics_per_chain,
      "fit-max-total-cubics": options.max_total_cubics,
      "fit-contrast-floor": options.contrast_floor,
    };
    for (const [id, value] of Object.entries(values)) {
      if (value !== undefined) {
        $(id).value = String(value);
      }
    }
    if (options.refine_subpixel !== undefined) {
      $("fit-subpixel").checked = Boolean(options.refine_subpixel);
    }
  } finally {
    state.suppressLiveRebuild = false;
  }
}

function collectFitterOptions() {
  return {
    coordinate_scale: coordinateScale(),
    max_error_px: numericValue("fit-error"),
    residual_sigmas: numericValue("fit-residual-sigmas"),
    samples_per_cubic: numericValue("fit-samples", true),
    reparameterization_iterations: numericValue("fit-reparameterization", true),
    corner_angle_degrees: numericValue("fit-corner-angle"),
    corner_window: numericValue("fit-corner-window", true),
    corner_run_edges: numericValue("fit-corner-run", true),
    corner_scale_octaves: numericValue("fit-corner-octaves", true),
    corner_scale_growth: numericValue("fit-corner-growth"),
    guide_smoothing: numericValue("fit-guide-smoothing"),
    topology_retries: numericValue("fit-topology-retries", true),
    refine_subpixel: $("fit-subpixel").checked,
    max_subpixel_offset_px: numericValue("fit-subpixel-bound"),
    subpixel_anchor_weight: numericValue("fit-subpixel-anchor"),
    max_cubics_per_chain: numericValue("fit-max-cubics-chain", true),
    max_total_cubics: numericValue("fit-max-total-cubics", true),
    contrast_floor: numericValue("fit-contrast-floor"),
    preserve_topology: $("preserve-topology").checked,
    threads: numericValue("threads", true),
  };
}

function applyRasterOptions(options) {
  state.suppressLiveRebuild = true;
  try {
    if (options.samples_per_axis !== undefined) {
      $("raster-samples").value = String(options.samples_per_axis);
    }
    if (options.band_height_px !== undefined) {
      $("raster-band-height").value = String(options.band_height_px);
    }
    if (options.color_space !== undefined) {
      $("raster-color-space").value = options.color_space;
    }
  } finally {
    state.suppressLiveRebuild = false;
  }
}

function collectRasterOptions(fixedInitialLength = 0) {
  return {
    samples_per_axis: numericValue("raster-samples", true),
    band_height_px: numericValue("raster-band-height", true),
    threads: numericValue("threads", true),
    color_space: $("raster-color-space").value,
    fixed_initial_length_px: fixedInitialLength,
  };
}

function applyRasterOptimizeOptions(options) {
  state.suppressLiveRebuild = true;
  try {
    const values = {
      "raster-refine-sweeps": options.max_sweeps,
      "raster-refine-samples": options.samples_per_axis,
      "raster-refine-band-height": options.band_height_px,
      "raster-refine-max-step": options.max_step_px,
      "raster-refine-step-scale": options.step_scale,
      "raster-refine-damping": options.hessian_damping,
      "raster-refine-line-search": options.max_line_search_steps,
      "raster-refine-relative-tolerance": options.relative_tolerance,
      "raster-refine-active-margin": options.active_margin_px,
      "raster-refine-color-space": options.color_space,
      "raster-refine-geometry-solver": options.geometry_solver,
      "raster-refine-block-schedule": options.block_schedule,
      "raster-refine-normalization": options.normalization,
      "raster-refine-angle-weight": options.angle_weight,
      "raster-refine-handle-weight": options.handle_weight,
      "raster-refine-length-weight": options.length_weight,
      "raster-refine-angle-epsilon": options.angle_epsilon_rad,
      "raster-refine-handle-epsilon": options.handle_epsilon_px,
      "raster-refine-color-iterations": options.color_solve_iterations,
      "raster-refine-color-regularization": options.color_regularization,
      "raster-refine-color-tolerance": options.color_tolerance,
    };
    for (const [id, value] of Object.entries(values)) {
      if (value !== undefined) {
        $(id).value = String(value);
      }
    }
    if (options.optimize_region_colors !== undefined) {
      $("raster-refine-colors").checked = Boolean(options.optimize_region_colors);
    }
  } finally {
    state.suppressLiveRebuild = false;
  }
}

function collectRasterOptimizeOptions(fixedInitialLength) {
  const geometrySolver = $("raster-refine-geometry-solver").value;
  return {
    max_sweeps: numericValue("raster-refine-sweeps", true),
    samples_per_axis: numericValue("raster-refine-samples", true),
    band_height_px: numericValue("raster-refine-band-height", true),
    threads: numericValue("threads", true),
    color_space: $("raster-refine-color-space").value,
    fixed_initial_length_px: fixedInitialLength,
    geometry_solver: geometrySolver,
    block_schedule: geometrySolver === "overlapping_blocks"
      ? $("raster-refine-block-schedule").value
      : "additive",
    normalization: $("raster-refine-normalization").value,
    coordinate_scale: coordinateScale(),
    step_scale: numericValue("raster-refine-step-scale"),
    hessian_damping: numericValue("raster-refine-damping"),
    max_step_px: numericValue("raster-refine-max-step"),
    max_line_search_steps: numericValue("raster-refine-line-search", true),
    relative_tolerance: numericValue("raster-refine-relative-tolerance"),
    angle_weight: numericValue("raster-refine-angle-weight"),
    handle_weight: numericValue("raster-refine-handle-weight"),
    length_weight: numericValue("raster-refine-length-weight"),
    angle_epsilon_rad: numericValue("raster-refine-angle-epsilon"),
    handle_epsilon_px: numericValue("raster-refine-handle-epsilon"),
    active_margin_px: numericValue("raster-refine-active-margin"),
    optimize_region_colors: $("raster-refine-colors").checked,
    color_solve_iterations: numericValue("raster-refine-color-iterations", true),
    color_regularization: numericValue("raster-refine-color-regularization"),
    color_tolerance: numericValue("raster-refine-color-tolerance"),
    preserve_topology: $("preserve-topology").checked,
    topology_flatness_px: numericValue("topology-flatness"),
    topology_cell_size_px: numericValue("topology-cell-size"),
  };
}

function applyLabUiDefaults() {
  state.suppressLiveRebuild = true;
  try {
    $("preprocess-color-space").value = "oklab";
    $("preprocess-seed").value = "components";
    $("raster-refine-enabled").checked = true;
    $("raster-auto-score").checked = true;
  } finally {
    state.suppressLiveRebuild = false;
  }
}

function applyNativeDefaultsPayload(defaults) {
  state.suppressLiveRebuild = true;
  try {
    applyOptions(defaults.options || {});
    applyPreprocessorOptions(defaults.preprocessor_options || {});
    applyFitterOptions(defaults.fitter_options || {});
    applyRasterOptions(defaults.raster_options || {});
    applyRasterOptimizeOptions(defaults.raster_optimizer_options || {});
    // The low-level ABI remains geometry-only by default so existing callers
    // need no writable color buffer. The raster lab opts into Yang's C solve.
    $("raster-refine-colors").checked = true;
    applyLabUiDefaults();
  } finally {
    state.suppressLiveRebuild = false;
  }
}

async function resetParametersToDefaults() {
  const button = $("defaults-button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    let defaults = state.nativeDefaults;
    try {
      defaults = await Backend.call("/api/defaults");
      state.nativeDefaults = defaults;
    } catch (error) {
      if (!defaults) {
        throw error;
      }
      logRun(`Defaults fetch failed (${error.message}); using cached native defaults.`);
    }
    applyNativeDefaultsPayload(defaults);
    logRun("Pipeline parameters restored to native/lab defaults.");
  } catch (error) {
    logRun(`Defaults error: ${error.message}`);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function rgbCanvasFromBase64(value, width, height) {
  const binary = atob(value);
  if (binary.length !== width * height * 3) {
    throw new Error("native filled preview has the wrong byte length");
  }
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outputContext = output.getContext("2d");
  const pixels = outputContext.createImageData(width, height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    pixels.data[4 * pixel] = binary.charCodeAt(3 * pixel);
    pixels.data[4 * pixel + 1] = binary.charCodeAt(3 * pixel + 1);
    pixels.data[4 * pixel + 2] = binary.charCodeAt(3 * pixel + 2);
    pixels.data[4 * pixel + 3] = 255;
  }
  outputContext.putImageData(pixels, 0, 0);
  return output;
}

function rasterChains(controlSets, includeSamples = false) {
  const scaleX = state.discrete.sourceWidth / state.discrete.width;
  const scaleY = state.discrete.sourceHeight / state.discrete.height;
  return state.problem.chains.map((chain, index) => {
    const output = {
      control_points: controlSets[index].map((point) => [
      point[0] / scaleX,
      point[1] / scaleY,
      ]),
      left_region: chain.left_region,
      right_region: chain.right_region,
      closed: chain.closed,
    };
    if (includeSamples) {
      output.samples = chain.samples.map((sample) => {
        const nx = sample.normal[0] * scaleX;
        const ny = sample.normal[1] * scaleY;
        const length = Math.max(1e-12, Math.hypot(nx, ny));
        return {
          ...sample,
          point: [sample.point[0] / scaleX, sample.point[1] / scaleY],
          normal: [nx / length, ny / length],
        };
      });
    }
    return output;
  });
}

function referenceChains(controlSets) {
  return rasterChains(controlSets, false);
}

function sourceChains(controlSets) {
  return state.problem.chains.map((chain, index) => ({
    control_points: controlSets[index].map((point) => [...point]),
    left_region: chain.left_region,
    right_region: chain.right_region,
    closed: chain.closed,
  }));
}

function rasterRegionColors(colorSpace) {
  return colorSpace === "linear"
    ? meanLinearRgb(
      state.discrete.rgb,
      state.discrete.labels,
      state.discrete.report.final_regions,
    )
    : meanSrgb(
      state.discrete.rgb,
      state.discrete.labels,
      state.discrete.report.final_regions,
    );
}

function encodedSrgbToLinear(value) {
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToEncodedSrgb(value) {
  return value <= 0.0031308
    ? 12.92 * value
    : 1.055 * value ** (1 / 2.4) - 0.055;
}

function convertRasterRegionColors(colors, fromSpace, toSpace) {
  if (!colors || fromSpace === toSpace) {
    return colors;
  }
  const convert = fromSpace === "srgb"
    ? encodedSrgbToLinear
    : linearToEncodedSrgb;
  return colors.map((value) => Math.max(0, Math.min(1, convert(value))));
}

function rasterNetworkLength(controlSets) {
  const nodes = [-0.906179845938664, -0.5384693101056831, 0, 0.5384693101056831, 0.906179845938664];
  const weights = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];
  let total = 0;
  const chains = rasterChains(controlSets, false);
  for (const chain of chains) {
    const segments = segmentCount(chain.control_points, chain.closed);
    for (let segment = 0; segment < segments; segment += 1) {
      const points = segmentPoints(chain.control_points, chain.closed, segment);
      let integral = 0;
      for (let sample = 0; sample < nodes.length; sample += 1) {
        const derivative = cubicDerivative(points, 0.5 * (nodes[sample] + 1));
        integral += weights[sample] * Math.hypot(derivative[0], derivative[1]);
      }
      total += 0.5 * integral;
    }
  }
  return total;
}

async function renderReferenceStage(
  controlSets,
  fixedInitialLength,
  regionColors = null,
  regionColorSpace = null,
) {
  const labelsBytes = new Uint8Array(
    state.discrete.labels.buffer,
    state.discrete.labels.byteOffset,
    state.discrete.labels.byteLength,
  );
  const scoreColorSpace = $("raster-color-space").value;
  const colors = regionColors
    ? convertRasterRegionColors(
      regionColors,
      regionColorSpace || scoreColorSpace,
      scoreColorSpace,
    )
    : rasterRegionColors(scoreColorSpace);
  const result = await Backend.call("/api/render-reference", {
    width: state.discrete.width,
    height: state.discrete.height,
    labels_base64: bytesToBase64(labelsBytes),
    rgb_base64: bytesToBase64(state.discrete.rgb),
    region_count: state.discrete.report.final_regions,
    region_linear_rgb: colors,
    chains: referenceChains(controlSets),
    options: collectRasterOptions(fixedInitialLength),
  });
  return {
    ...result,
    canvas: rgbCanvasFromBase64(result.rgb_base64, result.width, result.height),
  };
}

function buildFlatSvgPayload(controlSets) {
  return {
    width: state.discrete.sourceWidth,
    height: state.discrete.sourceHeight,
    region_count: state.discrete.report.final_regions,
    region_linear_rgb: meanSrgb(
      state.discrete.rgb,
      state.discrete.labels,
      state.discrete.report.final_regions,
    ),
    // Flat SVG is authored in source pixels. Do not pass proxyChains here:
    // that path exists for the native raster oracle, which works on the proxy.
    chains: sourceChains(controlSets),
  };
}

function loadFlatSvgPreviewImage(svgText) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ url, image });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("browser could not decode the flat SVG preview"));
    };
    image.src = url;
  });
}

async function refreshFlatSvgPreview() {
  if (!state.problem || !state.optimized || !state.discrete) {
    clearFlatSvgPreview();
    return null;
  }
  const result = await Backend.call("/api/export-flat-svg", buildFlatSvgPayload(state.optimized));
  const loaded = await loadFlatSvgPreviewImage(result.svg);
  clearFlatSvgPreview();
  state.svgPreview = {
    text: result.svg,
    url: loaded.url,
    image: loaded.image,
    regionCount: result.report.region_count,
    loopCount: result.report.loop_count,
    width: result.width,
    height: result.height,
  };
  $("export-svg-summary").dataset.state = "success";
  $("export-svg-summary").textContent =
    `${result.report.region_count} flat region${result.report.region_count === 1 ? "" : "s"} · ` +
    `${result.width}×${result.height} source px · ${compactNumber(result.report.loop_count)} boundary loop` +
    `${result.report.loop_count === 1 ? "" : "s"} · ${metricNumber(result.report.elapsed_ms, 2)} ms native`;
  syncPipelineActions();
  refreshRasterPreviewTabs();
  return state.svgPreview;
}

async function downloadFlatColoredSvg() {
  if (!state.problem || !state.optimized || !state.discrete) {
    return;
  }
  state.exportingSvg = true;
  const button = $("export-svg-button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Building SVG";
  $("export-svg-summary").dataset.state = "idle";
  $("export-svg-summary").textContent = "Stitching region loops from optimized curves…";
  try {
    const preview = state.svgPreview?.text
      ? state.svgPreview
      : await refreshFlatSvgPreview();
    if (!preview) {
      throw new Error("flat SVG preview is unavailable");
    }
    const baseName = (state.overlayName || "bezopt-flat").replace(/\.[^.]+$/, "");
    const blob = new Blob([preview.text], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${baseName}-flat.svg`;
    link.click();
    URL.revokeObjectURL(url);
    setPreview("flat-svg");
    logRun(`Exported flat SVG ${link.download} (${preview.regionCount} regions).`);
  } catch (error) {
    $("export-svg-summary").dataset.state = "error";
    $("export-svg-summary").textContent = error.message;
    logRun(`SVG export error: ${error.message}`);
  } finally {
    state.exportingSvg = false;
    button.removeAttribute("aria-busy");
    button.textContent = "Download flat SVG";
    syncPipelineActions();
  }
}

async function optimizeRasterStage(controlSets, fixedInitialLength) {
  const labelsBytes = new Uint8Array(
    state.discrete.labels.buffer,
    state.discrete.labels.byteOffset,
    state.discrete.labels.byteLength,
  );
  const colorSpace = $("raster-refine-color-space").value;
  const result = await Backend.call("/api/optimize-raster", {
    width: state.discrete.width,
    height: state.discrete.height,
    labels_base64: bytesToBase64(labelsBytes),
    rgb_base64: bytesToBase64(state.discrete.rgb),
    region_count: state.discrete.report.final_regions,
    region_linear_rgb: rasterRegionColors(colorSpace),
    chains: rasterChains(controlSets, true),
    options: collectRasterOptimizeOptions(fixedInitialLength),
  });
  const scaleX = state.discrete.sourceWidth / state.discrete.width;
  const scaleY = state.discrete.sourceHeight / state.discrete.height;
  return {
    ...result,
    color_space: colorSpace,
    controlSets: result.chains.map((chain) => chain.control_points.map((point) => [
      point[0] * scaleX,
      point[1] * scaleY,
    ])),
  };
}

function psnrSummary(report) {
  return report.psnr_db === null ? "∞ dB" : `${metricNumber(report.psnr_db, 2)} dB`;
}

async function renderReferenceFills(selectResult = true) {
  if (state.rendering || state.inputMode !== "raster" ||
      !state.problem || !state.discrete) {
    return;
  }
  state.rendering = true;
  const button = $("render-reference-button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Rendering fills";
  const summary = $("raster-reference-summary");
  summary.dataset.state = "idle";
  summary.textContent = "Rendering initializer and freezing Yang's initial length l₀…";
  try {
    const initialControls = state.problem.chains.map((chain) => chain.control_points);
    const initial = await renderReferenceStage(initialControls, 0);
    let optimized = null;
    if (state.optimized) {
      summary.textContent = "Rendering optimized controls with the same fixed l₀…";
      const refinement = state.response?.raster_refinement;
      const solvedColors = refinement?.report?.color_solves > 0
        ? refinement.region_linear_rgb
        : null;
      optimized = await renderReferenceStage(
        state.optimized,
        initial.report.initial_length_px,
        solvedColors,
        refinement?.color_space,
      );
    }
    state.reference = { initial, optimized };
    state.sessions.raster = captureSession();
    summary.dataset.state = "success";
    const totalMs = initial.report.elapsed_ms + (optimized?.report.elapsed_ms || 0);
    summary.textContent = optimized
      ? `${psnrSummary(initial.report)} → ${psnrSummary(optimized.report)} · ` +
        `Yang data ${metricNumber(initial.report.yang_data_energy, 4)} → ` +
        `${metricNumber(optimized.report.yang_data_energy, 4)} · ` +
        `${metricNumber(totalMs, 2)} ms native`
      : `${psnrSummary(initial.report)} initializer · ` +
        `Yang data ${metricNumber(initial.report.yang_data_energy, 4)} · ` +
        `${metricNumber(totalMs, 2)} ms native`;
    renderMetrics();
    refreshRasterPreviewTabs();
    const fillPreview = optimized ? "optimized-fill" : "initial-fill";
    if (state.liveRebuildRunning || !selectResult) {
      refreshPreviewAfterStage(fillPreview);
    } else {
      setPreview(fillPreview);
    }
    logRun(
      optimized
        ? `Filled RGB score: ${psnrSummary(initial.report)} → ` +
          `${psnrSummary(optimized.report)} with fixed l₀ ` +
          `${metricNumber(initial.report.initial_length_px, 2)} px.`
        : `Filled initializer score: ${psnrSummary(initial.report)}.`,
    );
  } catch (error) {
    summary.dataset.state = "error";
    summary.textContent = error.message;
    logRun(`Filled raster error: ${error.message}`);
  } finally {
    state.rendering = false;
    syncPipelineActions();
    button.removeAttribute("aria-busy");
    button.textContent = "Render filled stages";
  }
}

async function optimize() {
  if (state.running || !state.problem) {
    return;
  }
  state.running = true;
  $("run-button").disabled = true;
  $("run-button").setAttribute("aria-busy", "true");
  $("run-button-label").textContent = "Running";
  try {
    const rasterMode = state.inputMode === "raster" && Boolean(state.discrete);
    const runRasterRefinement = rasterMode && $("raster-refine-enabled").checked;
    const initialControls = state.problem.chains.map((chain) => chain.control_points);
    const fixedInitialLength = rasterMode ? rasterNetworkLength(initialControls) : 0;
    const result = await Backend.call("/api/optimize", {
      chains: state.problem.chains,
      options: collectOptions(),
    });
    state.report = result.report;
    let optimizedControls = result.chains.map((chain) => chain.control_points);
    let rasterResult = null;
    const rasterSummary = $("raster-refinement-summary");
    if (runRasterRefinement && result.report.status === 0) {
      rasterSummary.dataset.state = "idle";
      rasterSummary.textContent = "Integrating filled-RGB pixel-box gradients…";
      $("run-button-label").textContent = "Raster refining";
      try {
        rasterResult = await optimizeRasterStage(
          optimizedControls,
          fixedInitialLength,
        );
        optimizedControls = rasterResult.controlSets;
        state.rasterReport = rasterResult.report;
        rasterSummary.dataset.state = "success";
        const usesSolvedColors = rasterResult.report.color_solves > 0;
        const initialData = usesSolvedColors
          ? rasterResult.report.initial_full_data_energy
          : rasterResult.report.initial_data_energy;
        const finalData = usesSolvedColors
          ? rasterResult.report.final_full_data_energy
          : rasterResult.report.final_data_energy;
        rasterSummary.textContent =
          `${rasterResult.report.sweeps} accepted sweeps · ` +
          (rasterResult.report.geometry_blocks
            ? `${rasterResult.report.geometry_blocks} coupled blocks · `
            : "diagonal geometry · ") +
          `${rasterResult.report.geometry_batches} geometry batches · ` +
          (usesSolvedColors
            ? `${rasterResult.report.color_solves} color solves · `
            : "") +
          `${compactNumber(rasterResult.report.active_pixels)} active pixels · ` +
          `${metricNumber(initialData, 4)} → ` +
          `${metricNumber(finalData, 4)} data · ` +
          `${metricNumber(rasterResult.report.initial_objective, 4)} → ` +
          `${metricNumber(rasterResult.report.final_objective, 4)} joint · ` +
          `${metricNumber(rasterResult.report.elapsed_ms, 2)} ms native`;
      } catch (error) {
        state.rasterReport = null;
        rasterSummary.dataset.state = "error";
        rasterSummary.textContent = `Boundary result retained · ${error.message}`;
        logRun(`Filled-RGB refinement error: ${error.message}`);
      }
    } else {
      state.rasterReport = null;
      rasterSummary.dataset.state = "idle";
      rasterSummary.textContent = runRasterRefinement
        ? "Boundary optimizer did not return an OK state; raster pass skipped."
        : "Skipped for this run; showing the boundary/prior result.";
    }
    state.response = {
      ...result,
      raster_refinement: rasterResult,
      round_trip_ms: result.round_trip_ms + (rasterResult?.round_trip_ms || 0),
    };
    state.optimized = optimizedControls;
    state.reference = null;
    clearFlatSvgPreview();
    resetExportSvgSummary();
    state.sessions[state.inputMode] = captureSession();
    renderMetrics();
    if (state.inputMode === "raster") {
      if (result.report.status === 0) {
        try {
          await refreshFlatSvgPreview();
        } catch (svgError) {
          $("export-svg-summary").dataset.state = "error";
          $("export-svg-summary").textContent = svgError.message;
          logRun(`SVG preview error: ${svgError.message}`);
        }
      }
      if ($("raster-auto-score").checked) {
        await renderReferenceFills();
      } else if (state.liveRebuildRunning) {
        refreshPreviewAfterStage(state.svgPreview ? "flat-svg" : "optimized");
      } else {
        setPreview(state.svgPreview ? "flat-svg" : "optimized");
      }
    } else {
      draw();
    }
    logRun(
      `${statusLabel(result.report.status_text)} · ${metricNumber(result.report.elapsed_ms, 2)} ms · ` +
      `${compactNumber(result.report.sample_evaluations)} sample evaluations` +
      (rasterResult
        ? ` · filled RGB ${metricNumber(
          rasterResult.report.color_solves > 0
            ? rasterResult.report.initial_full_data_energy
            : rasterResult.report.initial_data_energy,
          4,
        )} → ` +
          `${metricNumber(
            rasterResult.report.color_solves > 0
              ? rasterResult.report.final_full_data_energy
              : rasterResult.report.final_data_energy,
            4,
          )} in ` +
          `${metricNumber(rasterResult.report.elapsed_ms, 2)} ms.`
        : "."),
    );
  } catch (error) {
    state.report = null;
    state.rasterReport = null;
    state.optimized = null;
    state.reference = null;
    renderMetrics();
    $("metric-status").textContent = "Bridge error";
    $("metric-status-detail").textContent = error.message;
    document.querySelector(".status-card").dataset.status = "error";
    logRun(`Error: ${error.message}`);
  } finally {
    state.running = false;
    syncPipelineActions();
    $("run-button").removeAttribute("aria-busy");
    $("run-button-label").textContent = "Optimize";
  }
}

function hitControl(x, y) {
  const editableStage = state.inputMode === "fixture" || state.preview === "initial";
  if (!editableStage || !state.problem || !$("display-controls").checked) {
    return null;
  }
  let best = null;
  let bestDistance = 10;
  state.problem.chains.forEach((chain, chainIndex) => {
    chain.control_points.forEach((point, pointIndex) => {
      const screen = toScreen(point);
      const distance = Math.hypot(screen[0] - x, screen[1] - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { chain: chainIndex, point: pointIndex };
      }
    });
  });
  return best;
}

function sharedPoints(reference) {
  const point = state.problem.chains[reference.chain].control_points[reference.point];
  const matches = [];
  state.problem.chains.forEach((chain, chainIndex) => {
    chain.control_points.forEach((candidate, pointIndex) => {
      if (Math.hypot(candidate[0] - point[0], candidate[1] - point[1]) < 1e-9) {
        matches.push({ chain: chainIndex, point: pointIndex });
      }
    });
  });
  return matches;
}

function canvasPosition(event) {
  const rectangle = canvas.getBoundingClientRect();
  return [event.clientX - rectangle.left, event.clientY - rectangle.top];
}

canvas.addEventListener("pointerdown", (event) => {
  const [x, y] = canvasPosition(event);
  const hit = hitControl(x, y);
  if (hit) {
    state.drag = { type: "control", points: sharedPoints(hit) };
    canvas.style.cursor = "grabbing";
  } else {
    state.drag = {
      type: "pan",
      x,
      y,
      offsetX: state.view.offsetX,
      offsetY: state.view.offsetY,
    };
    canvas.style.cursor = "grabbing";
  }
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  const [x, y] = canvasPosition(event);
  if (state.drag?.type === "control") {
    const world = toWorld(x, y);
    for (const reference of state.drag.points) {
      state.problem.chains[reference.chain].control_points[reference.point] = [...world];
    }
    state.optimized = null;
    state.reference = null;
    state.rasterReport = null;
    state.report = null;
    state.response = null;
    renderMetrics();
    draw();
    return;
  }
  if (state.drag?.type === "pan") {
    state.view.offsetX = state.drag.offsetX + x - state.drag.x;
    state.view.offsetY = state.drag.offsetY + y - state.drag.y;
    draw();
    return;
  }
  state.hover = hitControl(x, y);
  canvas.style.cursor = state.hover ? "grab" : "crosshair";
  draw();
});

function endDrag(event) {
  const wasControl = state.drag?.type === "control";
  if (state.drag) {
    state.drag = null;
    canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = state.hover ? "grab" : "crosshair";
  }
  if (wasControl) {
    scheduleLiveRebuild("optimize");
  }
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("dblclick", fitView);
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const [x, y] = canvasPosition(event);
    const before = toWorld(x, y);
    const factor = Math.exp(-event.deltaY * 0.0012);
    state.view.scale = Math.max(0.01, Math.min(80, state.view.scale * factor));
    state.view.offsetX = x - before[0] * state.view.scale;
    state.view.offsetY = y - before[1] * state.view.scale;
    draw();
  },
  { passive: false },
);

function resetProblem() {
  if (!state.baseline) {
    return;
  }
  state.problem = clone(state.baseline);
  state.optimized = null;
  state.reference = null;
  clearFlatSvgPreview();
  resetExportSvgSummary();
  state.rasterReport = null;
  state.report = null;
  state.response = null;
  state.sessions[state.inputMode] = captureSession();
  renderMetrics();
  fitView();
  logRun(`${state.inputMode === "fixture" ? "Fixture" : "Raster fit"} reset to its initial geometry.`);
}

function exportRun() {
  const payload = {
    schema: "bezopt.boundary-lab/v1",
    problem: clone(state.problem),
    options: collectOptions(),
    result: state.report
      ? { chains: state.optimized.map((controlPoints) => ({ control_points: controlPoints })), report: state.report }
      : null,
    raster_overlay: state.inputMode === "raster" && state.overlayName
      ? { name: state.overlayName, embedded: false }
      : null,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `bezopt-${state.preset || "fixture"}.json`;
  link.click();
  URL.revokeObjectURL(url);
  logRun("Exported the current fixture and run report.");
}

function removeOverlay() {
  state.vectorImage = null;
  $("vector-size-field").hidden = true;
  if (state.overlayUrl) {
    URL.revokeObjectURL(state.overlayUrl);
  }
  state.overlayImage = null;
  state.overlayUrl = null;
  state.overlayName = null;
  state.discrete = null;
  state.problem = null;
  state.baseline = null;
  state.optimized = null;
  state.reference = null;
  clearFlatSvgPreview();
  resetExportSvgSummary();
  state.rasterReport = null;
  state.report = null;
  state.response = null;
  state.preview = "source";
  renderTargetDiagnostics();
  $("remove-overlay-button").disabled = true;
  $("preprocess-button").disabled = true;
  $("fit-curves-button").disabled = true;
  $("preprocess-summary").dataset.state = "idle";
  $("preprocess-summary").textContent = "Load a raster to test native discrete preprocessing.";
  $("raster-reference-summary").dataset.state = "idle";
  $("raster-reference-summary").textContent = "Fit curves to enable filled-region validation.";
  $("raster-name").textContent = "No raster loaded";
  $("raster-dimensions").textContent = "Choose a local PNG, JPEG, or WebP.";
  state.sessions.raster = captureSession();
  syncModeUi();
  draw();
  logRun("Removed the local raster input and its derived stages.");
}

// A raster's resolution is data: resampling it would destroy the very thing the
// engine measures, which is why the preprocessor refuses to and a test enforces
// that. A vector source has no resolution until we pick one, so the choice
// belongs here, at ingestion, not downstream. Rasterizing once keeps everything
// after this point identical for both kinds of input.
//
// The result is a canvas rather than an Image. Everything downstream needs only
// naturalWidth, naturalHeight and drawImage, and a canvas satisfies all three
// once the two sizes are defined on it. Going through toDataURL instead would
// be asynchronous and could throw a SecurityError, because whether drawing an
// SVG taints a canvas has varied by browser and by what the file references.
// Not creating that failure mode is better than handling it.
function rasterizeVector(image, longestEdge) {
  const natural = Math.max(image.naturalWidth, image.naturalHeight);
  const factor = longestEdge / natural;
  const width = Math.max(1, Math.round(image.naturalWidth * factor));
  const height = Math.max(1, Math.round(image.naturalHeight * factor));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const drawing = canvas.getContext("2d");
  drawing.fillStyle = "#ffffff";
  drawing.fillRect(0, 0, width, height);
  drawing.imageSmoothingEnabled = true;
  drawing.imageSmoothingQuality = "high";
  drawing.drawImage(image, 0, 0, width, height);
  Object.defineProperty(canvas, "naturalWidth", { value: width });
  Object.defineProperty(canvas, "naturalHeight", { value: height });
  return canvas;
}

function applyVectorRenderSize() {
  if (!state.vectorImage) {
    return;
  }
  const requested = Math.max(16, Math.min(4096, numericValue("vector-render-size", true)));
  const raster = rasterizeVector(state.vectorImage, requested);
  state.overlayImage = raster;
  // The source changed, so every stage computed from the old one is stale.
  state.discrete = null;
  state.problem = null;
  state.baseline = null;
  state.optimized = null;
  state.reference = null;
  state.rasterReport = null;
  state.report = null;
  state.response = null;
  clearFlatSvgPreview();
  state.preview = "source";
  $("fit-curves-button").disabled = true;
  $("preprocess-summary").dataset.state = "idle";
  $("preprocess-summary").textContent =
    `${raster.naturalWidth}×${raster.naturalHeight} rasterized from vector, on white · choose a target and run.`;
  $("raster-dimensions").textContent =
    `${raster.naturalWidth}×${raster.naturalHeight} source pixels · rasterized from ${state.overlayName}`;
  renderTargetDiagnostics();
  refreshRasterPreviewTabs();
  draw();
}

function loadOverlay(file) {
  if (state.inputMode !== "raster") {
    setInputMode("raster");
  }
  const url = URL.createObjectURL(file);
  const vector = /\.svg$/i.test(file.name) || file.type === "image/svg+xml";
  const image = new Image();
  image.onerror = () => {
    URL.revokeObjectURL(url);
    $("preprocess-summary").dataset.state = "error";
    $("preprocess-summary").textContent =
      `${file.name} could not be decoded. For SVG, flatten it first: expand ` +
      "strokes, convert text to paths, and remove external references.";
  };
  image.onload = () => {
    // An SVG carrying only a viewBox, or none at all, can decode with no
    // intrinsic size. Rasterizing that silently produces an empty or
    // 300x150 default, so say so instead.
    if (!image.naturalWidth || !image.naturalHeight) {
      URL.revokeObjectURL(url);
      $("preprocess-summary").dataset.state = "error";
      $("preprocess-summary").textContent =
        `${file.name} has no intrinsic size. Add width and height attributes ` +
        "to the <svg> element (a viewBox alone is not enough here).";
      return;
    }
    if (state.overlayUrl) {
      URL.revokeObjectURL(state.overlayUrl);
    }
    state.vectorImage = vector ? image : null;
    $("vector-size-field").hidden = !vector;
    if (vector) {
      // Default to the file's own size so nothing is silently resampled, but
      // make the control visible immediately: an icon's intrinsic size is often
      // far too small to say anything useful about the fitter.
      $("vector-render-size").value = String(
        Math.max(16, Math.min(4096, Math.round(
          Math.max(image.naturalWidth, image.naturalHeight)))));
    }
    state.overlayImage = image;
    state.overlayUrl = url;
    state.overlayName = file.name;
    state.discrete = null;
    state.problem = null;
    state.baseline = null;
    state.optimized = null;
    state.reference = null;
    state.rasterReport = null;
    state.report = null;
    state.response = null;
    state.preview = "source";
    renderTargetDiagnostics();
    $("remove-overlay-button").disabled = false;
    $("preprocess-button").disabled = false;
    $("fit-curves-button").disabled = true;
    $("preprocess-summary").dataset.state = "idle";
    $("preprocess-summary").textContent =
      `${image.naturalWidth}×${image.naturalHeight} loaded` +
      `${/\.svg$/i.test(file.name) ? " (SVG rasterized at its intrinsic size, on white)" : ""}` +
      " · choose a target and run.";
    $("raster-reference-summary").dataset.state = "idle";
    $("raster-reference-summary").textContent = "Fit curves to enable filled-region validation.";
    $("raster-name").textContent = file.name;
    $("raster-dimensions").textContent = `${image.naturalWidth}×${image.naturalHeight} source pixels · local only`;
    $("overlay-file").value = "";
    state.sessions.raster = captureSession();
    refreshRasterPreviewTabs();
    fitView();
    logRun(`Loaded local ${vector ? "vector" : "raster"} overlay ${file.name} ` +
           `(${image.naturalWidth}×${image.naturalHeight}).`);
    if (vector) {
      applyVectorRenderSize();
    }
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    $("overlay-file").value = "";
    logRun(`Could not decode raster overlay ${file.name}.`);
  };
  image.src = url;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function uint32FromBase64(value, count) {
  const binary = atob(value);
  if (binary.length !== count * 4) {
    throw new Error("native label payload has the wrong byte length");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const view = new DataView(bytes.buffer);
  const labels = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    labels[index] = view.getUint32(index * 4, true);
  }
  return labels;
}

function connectedColorLabels(rgb, width, height) {
  const pixels = width * height;
  const parent = new Uint32Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    parent[index] = index;
  }
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) {
      root = parent[root];
    }
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const unite = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) {
      if (a < b) {
        parent[b] = a;
      } else {
        parent[a] = b;
      }
    }
  };
  const same = (left, right) => {
    const a = 3 * left;
    const b = 3 * right;
    return rgb[a] === rgb[b] && rgb[a + 1] === rgb[b + 1] && rgb[a + 2] === rgb[b + 2];
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (x > 0 && same(pixel, pixel - 1)) {
        unite(pixel, pixel - 1);
      }
      if (y > 0 && same(pixel, pixel - width)) {
        unite(pixel, pixel - width);
      }
    }
  }
  const compact = new Map();
  const labels = new Uint32Array(pixels);
  let count = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const root = find(pixel);
    if (!compact.has(root)) {
      compact.set(root, count);
      count += 1;
    }
    labels[pixel] = compact.get(root);
  }
  return { labels, count };
}

function makeLabelBoundarySegments(labels, width, height) {
  const values = [];
  let count = 0;
  let overflow = false;
  const append = (x0, y0, x1, y1) => {
    count += 1;
    if (overflow) {
      return;
    }
    if (count > MAX_LABEL_BOUNDARY_SEGMENTS) {
      values.length = 0;
      overflow = true;
      return;
    }
    values.push(x0, y0, x1, y1);
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x + 1 < width; x += 1) {
      const pixel = y * width + x;
      if (labels[pixel] !== labels[pixel + 1]) {
        append(x + 1, y, x + 1, y + 1);
      }
    }
  }
  for (let y = 0; y + 1 < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (labels[pixel] !== labels[pixel + width]) {
        append(x, y + 1, x + 1, y + 1);
      }
    }
  }
  return {
    count,
    segments: overflow ? null : new Float32Array(values),
    exact: !overflow,
  };
}

function makeBoundaryCanvas(labels, width, height) {
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outputContext = output.getContext("2d");
  const pixels = outputContext.createImageData(width, height);
  const mark = (index) => {
    const base = 4 * index;
    pixels.data[base] = 107;
    pixels.data[base + 1] = 167;
    pixels.data[base + 2] = 255;
    pixels.data[base + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if ((x + 1 < width && labels[pixel] !== labels[pixel + 1]) ||
          (y + 1 < height && labels[pixel] !== labels[pixel + width])) {
        mark(pixel);
      }
    }
  }
  outputContext.putImageData(pixels, 0, 0);
  return output;
}

function makeFlatRegionCanvas(rgb, labels, regionCount, width, height) {
  const sums = new Float64Array(regionCount * 3);
  const counts = new Uint32Array(regionCount);
  for (let pixel = 0; pixel < labels.length; pixel += 1) {
    const region = labels[pixel];
    counts[region] += 1;
    sums[3 * region] += rgb[3 * pixel];
    sums[3 * region + 1] += rgb[3 * pixel + 1];
    sums[3 * region + 2] += rgb[3 * pixel + 2];
  }
  for (let region = 0; region < regionCount; region += 1) {
    const count = Math.max(1, counts[region]);
    sums[3 * region] /= count;
    sums[3 * region + 1] /= count;
    sums[3 * region + 2] /= count;
  }
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outputContext = output.getContext("2d");
  const pixels = outputContext.createImageData(width, height);
  for (let pixel = 0; pixel < labels.length; pixel += 1) {
    const region = labels[pixel];
    pixels.data[4 * pixel] = Math.round(sums[3 * region]);
    pixels.data[4 * pixel + 1] = Math.round(sums[3 * region + 1]);
    pixels.data[4 * pixel + 2] = Math.round(sums[3 * region + 2]);
    pixels.data[4 * pixel + 3] = 255;
  }
  outputContext.putImageData(pixels, 0, 0);
  return output;
}

function preprocessRasterPayload() {
  const sourceWidth = state.overlayImage.naturalWidth;
  const sourceHeight = state.overlayImage.naturalHeight;
  const maxMp = Math.max(0.1, numericValue("preprocess-max-mp", true) || 4);
  const maxPixels = Math.floor(maxMp * 1000000);
  const allowDownsample = $("preprocess-downsample").checked;
  let width = sourceWidth;
  let height = sourceHeight;
  let downsampled = false;
  if (width * height > maxPixels) {
    if (!allowDownsample) {
      throw new Error(
        "Full-resolution raster exceeds the " + maxMp.toFixed(1) + "-megapixel limit; " +
        "enable 'Downsample if over limit' or use the in-process native API rather than downsampling discrete topology.",
      );
    }
    // Explicit user-consented downsample (not silent: the checkbox is visible
    // and we flag the output). Scale to fit within the pixel budget.
    const scale = Math.sqrt(maxPixels / (width * height));
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
    downsampled = true;
    console.warn(
      "Downsampled raster from " + sourceWidth + "x" + sourceHeight +
      " to " + width + "x" + height + "; discrete topology may differ.",
    );
  }
  const raster = document.createElement("canvas");
  raster.width = width;
  raster.height = height;
  const rasterContext = raster.getContext("2d", { willReadFrequently: true });
  // A fresh canvas is transparent black, and the copy below takes RGB while
  // ignoring alpha, so anything transparent would arrive at the segmenter as
  // pure black -- which is why an SVG with no background used to merge into one
  // black region. Compositing onto white first is what a viewer does anyway, and
  // it matches how the CLI harnesses load images.
  rasterContext.fillStyle = "#ffffff";
  rasterContext.fillRect(0, 0, width, height);
  // Use high-quality downsampling when shrinking.
  rasterContext.imageSmoothingEnabled = true;
  rasterContext.imageSmoothingQuality = "high";
  rasterContext.drawImage(state.overlayImage, 0, 0, width, height);
  if (downsampled) {
    // Flag in the UI that the raster was downsampled.
    const note = document.getElementById("preprocess-downsample-note");
    if (note) {
      note.textContent =
        "Raster downsampled to " + width + "x" + height +
        " (from " + sourceWidth + "x" + sourceHeight + "); topology may differ from full resolution.";
      note.style.display = "block";
    }
  }
  const rgba = rasterContext.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgb[3 * pixel] = rgba[4 * pixel];
    rgb[3 * pixel + 1] = rgba[4 * pixel + 1];
    rgb[3 * pixel + 2] = rgba[4 * pixel + 2];
  }
  let seeds = null;
  if ($("preprocess-seed").value === "components") {
    seeds = connectedColorLabels(rgb, width, height);
  }
  const requestedTarget = numericValue("preprocess-target", true);
  const availableRegions = seeds ? seeds.count : width * height;
  const payload = {
    width,
    height,
    rgb_base64: bytesToBase64(rgb),
    color_space: $("preprocess-color-space").value,
    options: {
      target_regions: Math.max(1, Math.min(requestedTarget, availableRegions)),
      criterion: $("preprocess-criterion").value,
      iterations: numericValue("preprocess-iterations", true),
      area_exponent: numericValue("preprocess-area-exponent"),
      area_smallness_scale: numericValue("preprocess-smallness"),
      area_raster_bias: numericValue("preprocess-raster-bias"),
      saliency_weight: numericValue("preprocess-saliency"),
      topology_weight: numericValue("preprocess-topology"),
    },
  };
  if (seeds) {
    payload.initial_labels_base64 = bytesToBase64(new Uint8Array(seeds.labels.buffer));
    payload.initial_region_count = seeds.count;
  }
  return { payload, rgb, sourceWidth, sourceHeight };
}

function srgbByteToLinear(value) {
  return encodedSrgbToLinear(value / 255);
}

const linearSrgbLookup = Float64Array.from(
  { length: 256 },
  (_unused, value) => srgbByteToLinear(value),
);

function meanLinearRgb(rgb, labels, regionCount) {
  const sums = new Float64Array(regionCount * 3);
  const counts = new Uint32Array(regionCount);
  for (let pixel = 0; pixel < labels.length; pixel += 1) {
    const region = labels[pixel];
    const base = 3 * region;
    sums[base] += linearSrgbLookup[rgb[3 * pixel]];
    sums[base + 1] += linearSrgbLookup[rgb[3 * pixel + 1]];
    sums[base + 2] += linearSrgbLookup[rgb[3 * pixel + 2]];
    counts[region] += 1;
  }
  for (let region = 0; region < regionCount; region += 1) {
    const count = Math.max(1, counts[region]);
    sums[3 * region] /= count;
    sums[3 * region + 1] /= count;
    sums[3 * region + 2] /= count;
  }
  return Array.from(sums);
}

function meanSrgb(rgb, labels, regionCount) {
  const sums = new Float64Array(regionCount * 3);
  const counts = new Uint32Array(regionCount);
  for (let pixel = 0; pixel < labels.length; pixel += 1) {
    const region = labels[pixel];
    const base = 3 * region;
    sums[base] += rgb[3 * pixel] / 255;
    sums[base + 1] += rgb[3 * pixel + 1] / 255;
    sums[base + 2] += rgb[3 * pixel + 2] / 255;
    counts[region] += 1;
  }
  for (let region = 0; region < regionCount; region += 1) {
    const count = Math.max(1, counts[region]);
    sums[3 * region] /= count;
    sums[3 * region + 1] /= count;
    sums[3 * region + 2] /= count;
  }
  return Array.from(sums);
}

async function preprocessRaster() {
  if (state.preprocessing || !state.overlayImage) {
    return;
  }
  state.preprocessing = true;
  const button = $("preprocess-button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Building RAG";
  $("preprocess-summary").dataset.state = "idle";
  $("preprocess-summary").textContent = "Preparing full-resolution raster and connected components…";
  try {
    const prepared = preprocessRasterPayload();
    const result = await Backend.call("/api/preprocess", prepared.payload);
    const labels = uint32FromBase64(result.labels_base64, result.width * result.height);
    state.problem = null;
    state.baseline = null;
    state.optimized = null;
    state.reference = null;
    clearFlatSvgPreview();
    resetExportSvgSummary();
    state.rasterReport = null;
    state.report = null;
    state.response = null;
    state.discrete = {
      ...result,
      labels,
      rgb: prepared.rgb,
      sourceWidth: prepared.sourceWidth,
      sourceHeight: prepared.sourceHeight,
      labelBoundary: makeLabelBoundarySegments(labels, result.width, result.height),
      boundaryCanvas: makeBoundaryCanvas(labels, result.width, result.height),
      flatCanvas: makeFlatRegionCanvas(
        prepared.rgb,
        labels,
        result.report.final_regions,
        result.width,
        result.height,
      ),
    };
    renderTargetDiagnostics();
    const report = result.report;
    $("preprocess-summary").dataset.state = "success";
    $("preprocess-summary").textContent =
      `${compactNumber(report.initial_regions)} → ${compactNumber(report.final_regions)} regions · ` +
      `${compactNumber(report.rag_edges)} edges · ${metricNumber(report.elapsed_ms, 2)} ms native · ` +
      `${result.width}×${result.height} full resolution · ` +
      `${metricNumber(coordinateScale(), 2)}× solver scale`;
    $("fit-curves-button").disabled = result.report.final_regions < 2;
    state.sessions.raster = captureSession();
    syncPipelineActions();
    if (state.liveRebuildRunning) {
      refreshPreviewAfterStage("regions");
    } else {
      setPreview("regions");
    }
    logRun(
      `Discrete VBRM: ${compactNumber(report.initial_regions)} → ` +
      `${compactNumber(report.final_regions)} regions in ${metricNumber(report.elapsed_ms, 2)} ms.`,
    );
  } catch (error) {
    state.discrete = null;
    renderTargetDiagnostics();
    $("fit-curves-button").disabled = true;
    $("preprocess-summary").dataset.state = "error";
    $("preprocess-summary").textContent = error.message;
    refreshRasterPreviewTabs();
    draw();
    logRun(`Preprocessor error: ${error.message}`);
  } finally {
    state.preprocessing = false;
    button.disabled = !state.overlayImage;
    button.removeAttribute("aria-busy");
    button.textContent = "Run discrete";
  }
}

function scaleFittedProblem(chains, scaleX, scaleY) {
  return {
    chains: chains.map((chain) => ({
      control_points: chain.control_points.map((point) => [
        point[0] * scaleX,
        point[1] * scaleY,
      ]),
      samples: chain.samples.map((sample) => {
        // Sample weight contains represented boundary arc length.  Under the
        // slightly anisotropic scale caused by a future raster working level, that
        // length follows the transformed tangent rather than an area/geometric
        // mean.  The normal uses the corresponding inverse-transpose map.
        const tangentX = -sample.normal[1];
        const tangentY = sample.normal[0];
        const weightScale = Math.hypot(tangentX * scaleX, tangentY * scaleY);
        const nx = sample.normal[0] / scaleX;
        const ny = sample.normal[1] / scaleY;
        const length = Math.max(1e-12, Math.hypot(nx, ny));
        return {
          ...sample,
          point: [sample.point[0] * scaleX, sample.point[1] * scaleY],
          normal: [nx / length, ny / length],
          weight: sample.weight * weightScale,
        };
      }),
      left_region: chain.left_region,
      right_region: chain.right_region,
      closed: chain.closed,
    })),
  };
}

function scaleEvidenceContours(chains, scaleX, scaleY) {
  return chains.map((chain) => (chain.source_points || []).map((point) => [
    point[0] * scaleX,
    point[1] * scaleY,
  ]));
}

async function fitDiscreteBoundaries() {
  if (state.fitting || !state.discrete) {
    return;
  }
  state.fitting = true;
  const button = $("fit-curves-button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Fitting curves";
  state.discrete.targetDiagnostics = null;
  renderTargetDiagnostics();
  try {
    const labelsBytes = new Uint8Array(
      state.discrete.labels.buffer,
      state.discrete.labels.byteOffset,
      state.discrete.labels.byteLength,
    );
    const result = await Backend.call("/api/fit", {
      width: state.discrete.width,
      height: state.discrete.height,
      labels_base64: bytesToBase64(labelsBytes),
      rgb_base64: bytesToBase64(state.discrete.rgb),
      region_count: state.discrete.report.final_regions,
      region_linear_rgb: meanLinearRgb(
        state.discrete.rgb,
        state.discrete.labels,
        state.discrete.report.final_regions,
      ),
      options: collectFitterOptions(),
    });
    if (!Array.isArray(result.chains) || result.chains.length === 0) {
      throw new Error("the segmentation has no internal region interfaces to fit");
    }
    const problem = scaleFittedProblem(
      result.chains,
      state.discrete.sourceWidth / state.discrete.width,
      state.discrete.sourceHeight / state.discrete.height,
    );
    state.discrete.evidenceContours = scaleEvidenceContours(
      result.chains,
      state.discrete.sourceWidth / state.discrete.width,
      state.discrete.sourceHeight / state.discrete.height,
    );
    state.problem = problem;
    state.baseline = clone(problem);
    state.optimized = null;
    state.reference = null;
    clearFlatSvgPreview();
    resetExportSvgSummary();
    state.rasterReport = null;
    state.report = null;
    state.response = null;
    state.preset = "fitted-raster";
    state.hover = null;
    state.sessions.raster = captureSession();
    $("raster-reference-summary").dataset.state = "idle";
    $("raster-reference-summary").textContent =
      "Render the filled initializer, then optimize to compare fixed-l₀ RGB scores.";
    $("raster-refinement-summary").dataset.state = "idle";
    $("raster-refinement-summary").textContent =
      "Ready · Run Optimize to execute boundary priors and direct filled RGB.";
    syncPipelineActions();
    renderMetrics();
    if (state.liveRebuildRunning) {
      refreshPreviewAfterStage("initial");
    } else {
      setPreview("initial");
    }
    const report = result.report;
    state.discrete.fitReport = report;
    state.discrete.targetDiagnostics = result.target_diagnostics;
    renderTargetDiagnostics();
    const evidenceSummary = report.subpixel_edges > 0
      ? `${compactNumber(report.subpixel_edges)} RGB edges · mean |Δ| ` +
        `${metricNumber(report.mean_abs_subpixel_offset_px, 3)} px`
      : "exact-grid targets";
    const totalChains = report.open_chains + report.closed_chains;
    const recoverySummary = report.grid_fallback_chains > 0
      ? `exact-grid fallback on ${compactNumber(report.grid_fallback_chains)}/` +
        `${compactNumber(totalChains)} chains`
      : report.recovered_chains > 0
        ? `planar-guide recovery on ${compactNumber(report.recovered_chains)}/` +
          `${compactNumber(totalChains)} chains`
        : "first candidate planar";
    $("preprocess-summary").dataset.state = "success";
    $("preprocess-summary").textContent =
      `${compactNumber(state.discrete.report.final_regions)} regions · ` +
      `${compactNumber(report.open_chains + report.closed_chains)} shared chains · ` +
      `${compactNumber(report.cubics)} cubics · ${metricNumber(report.elapsed_ms, 2)} ms fit · ` +
      `${compactNumber(report.smoothed_guide_vertices)} guides smoothed · ` + evidenceSummary +
      ` · ${recoverySummary} · ${metricNumber(coordinateScale(), 2)}× solver scale`;
    logRun(
      `Boundary fit: ${compactNumber(report.raster_boundary_edges)} grid edges → ` +
      `${compactNumber(report.cubics)} cubics and ${compactNumber(report.target_samples)} targets ` +
      `in ${metricNumber(report.elapsed_ms, 2)} ms; ` +
      `${compactNumber(report.subpixel_edges)} RGB-localized edges ` +
      `(mean |Δ| ${metricNumber(report.mean_abs_subpixel_offset_px, 3)} px); ` +
      `${compactNumber(report.detected_corners)} pinned corners, ` +
      `${compactNumber(report.smoothed_guide_vertices)} smoothed guides ` +
      `(mean ${metricNumber(report.mean_guide_displacement_px, 3)} px); ` +
      `${recoverySummary}.`,
    );
  } catch (error) {
    $("preprocess-summary").dataset.state = "error";
    $("preprocess-summary").textContent = error.message;
    $("target-diagnostics-summary").dataset.state = "error";
    $("target-diagnostics-summary").textContent = `Target diagnostics unavailable: ${error.message}`;
    logRun(`Fitter error: ${error.message}`);
  } finally {
    state.fitting = false;
    button.disabled = !state.discrete || state.discrete.report.final_regions < 2;
    button.removeAttribute("aria-busy");
    button.textContent = "Fit curves";
  }
}

async function importRun(file) {
  try {
    const payload = JSON.parse(await file.text());
    const problem = payload.problem || (payload.chains ? { chains: payload.chains } : null);
    if (!problem || !Array.isArray(problem.chains) || problem.chains.length === 0) {
      throw new Error("JSON must contain a non-empty problem.chains or chains array.");
    }
    if (state.inputMode !== "fixture") {
      setInputMode("fixture");
    }
    state.problem = clone(problem);
    state.baseline = clone(problem);
    state.optimized = null;
    state.reference = null;
    state.rasterReport = null;
    state.report = null;
    state.response = null;
    state.preset = "imported";
    $("preset-description").textContent = `Imported ${file.name}`;
    if (payload.options) {
      applyOptions(payload.options);
    }
    state.sessions.fixture = captureSession();
    syncModeUi();
    renderMetrics();
    fitView();
    logRun(`Imported ${file.name}.`);
  } catch (error) {
    logRun(`Import error: ${error.message}`);
  } finally {
    $("import-file").value = "";
  }
}

const LIVE_REBUILD_MS = 500;
const LIVE_REBUILD_STAGES = Object.freeze(["discrete", "fit", "optimize", "score"]);

function liveRebuildStageIndex(stage) {
  return LIVE_REBUILD_STAGES.indexOf(stage);
}

function liveRebuildStageForControl(id) {
  if (
    !id ||
    id === "live-rebuild" ||
    id === "preset-select" ||
    id === "overlay-opacity" ||
    id.startsWith("display-") ||
    id === "raster-auto-score"
  ) {
    return null;
  }
  if (id.startsWith("preprocess-")) {
    return "discrete";
  }
  if (id.startsWith("fit-") || (id === "preserve-topology" && state.inputMode === "raster")) {
    return "fit";
  }
  if (id.startsWith("raster-refine-")) {
    return "optimize";
  }
  if (id.startsWith("raster-")) {
    return "score";
  }
  return "optimize";
}

function earliestLiveRebuildStage(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return liveRebuildStageIndex(left) <= liveRebuildStageIndex(right) ? left : right;
}

function cascadeEndStage() {
  if (state.inputMode === "fixture") {
    return state.problem ? "optimize" : null;
  }
  if (state.optimized || state.reference || state.rasterReport) {
    return "optimize";
  }
  if (state.problem) {
    return "fit";
  }
  if (state.discrete) {
    return "discrete";
  }
  return null;
}

function scheduleLiveRebuild(stage) {
  if (!state.liveRebuild || state.suppressLiveRebuild || !stage) {
    return;
  }
  state.liveRebuildPendingStage = earliestLiveRebuildStage(
    state.liveRebuildPendingStage,
    stage,
  );
  if (state.liveRebuildTimer !== null) {
    clearTimeout(state.liveRebuildTimer);
  }
  state.liveRebuildTimer = setTimeout(() => {
    state.liveRebuildTimer = null;
    void runLiveRebuild();
  }, LIVE_REBUILD_MS);
}

function liveRebuildBusy() {
  return (
    state.liveRebuildRunning ||
    state.running ||
    state.preprocessing ||
    state.fitting ||
    state.rendering
  );
}

async function runLiveRebuild() {
  if (!state.liveRebuild) {
    state.liveRebuildPendingStage = null;
    return;
  }
  if (liveRebuildBusy()) {
    if (state.liveRebuildPendingStage && state.liveRebuildTimer === null) {
      state.liveRebuildTimer = setTimeout(() => {
        state.liveRebuildTimer = null;
        void runLiveRebuild();
      }, LIVE_REBUILD_MS);
    }
    return;
  }

  const start = state.liveRebuildPendingStage;
  state.liveRebuildPendingStage = null;
  if (!start) {
    return;
  }

  const retainedPreview = state.preview;
  const retainedView = {
    scale: state.view.scale,
    offsetX: state.view.offsetX,
    offsetY: state.view.offsetY,
  };
  state.liveRebuildRunning = true;
  try {
    if (start === "score") {
      if (state.problem && state.inputMode === "raster") {
        await renderReferenceFills();
      }
      return;
    }

    if (state.inputMode === "fixture") {
      if (state.problem) {
        await optimize();
      }
      return;
    }

    let end = cascadeEndStage();
    if (!end) {
      end = start;
    } else if (liveRebuildStageIndex(start) > liveRebuildStageIndex(end)) {
      end = start;
    }
    if (liveRebuildStageIndex(end) > liveRebuildStageIndex("optimize")) {
      end = "optimize";
    }

    const from = liveRebuildStageIndex(start);
    const to = liveRebuildStageIndex(end);
    for (let index = from; index <= to; index += 1) {
      const stage = LIVE_REBUILD_STAGES[index];
      if (stage === "discrete") {
        if (!state.overlayImage) {
          break;
        }
        await preprocessRaster();
        if (!state.discrete) {
          break;
        }
      } else if (stage === "fit") {
        if (!state.discrete || state.discrete.report.final_regions < 2) {
          break;
        }
        await fitDiscreteBoundaries();
        if (!state.problem) {
          break;
        }
      } else if (stage === "optimize") {
        if (!state.problem) {
          break;
        }
        await optimize();
      }
    }
  } finally {
    state.view.scale = retainedView.scale;
    state.view.offsetX = retainedView.offsetX;
    state.view.offsetY = retainedView.offsetY;
    state.preview = retainedPreview;
    state.liveRebuildRunning = false;
    refreshPreviewAfterStage(retainedPreview);
    if (state.liveRebuildPendingStage && state.liveRebuild) {
      scheduleLiveRebuild(state.liveRebuildPendingStage);
    }
  }
}

function installLiveRebuildListeners() {
  $("live-rebuild").addEventListener("change", (event) => {
    state.liveRebuild = event.target.checked;
    if (!state.liveRebuild) {
      if (state.liveRebuildTimer !== null) {
        clearTimeout(state.liveRebuildTimer);
        state.liveRebuildTimer = null;
      }
      state.liveRebuildPendingStage = null;
    }
  });

  const controls = document.querySelectorAll(
    ".inspector input[id]:not([type='file']), .inspector select[id]",
  );
  for (const control of controls) {
    const stage = liveRebuildStageForControl(control.id);
    if (!stage) {
      continue;
    }
    const notify = () => scheduleLiveRebuild(stage);
    control.addEventListener("input", notify);
    if (control.type === "checkbox" || control.tagName === "SELECT") {
      control.addEventListener("change", notify);
    }
  }
}

$("preset-select").addEventListener("change", (event) => setPreset(event.target.value));
for (const button of document.querySelectorAll("[data-input-mode]")) {
  button.addEventListener("click", () => setInputMode(button.dataset.inputMode));
}
for (const button of document.querySelectorAll("[data-preview]")) {
  button.addEventListener("click", () => setPreview(button.dataset.preview));
}
$("run-button").addEventListener("click", optimize);
$("reset-button").addEventListener("click", resetProblem);
$("defaults-button").addEventListener("click", () => {
  void resetParametersToDefaults();
});
$("fit-button").addEventListener("click", fitView);
$("import-button").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", (event) => {
  if (event.target.files[0]) {
    importRun(event.target.files[0]);
  }
});
$("export-button").addEventListener("click", exportRun);
$("overlay-button").addEventListener("click", () => $("overlay-file").click());
$("overlay-file").addEventListener("change", (event) => {
  if (event.target.files[0]) {
    loadOverlay(event.target.files[0]);
  }
});
$("preprocess-button").addEventListener("click", preprocessRaster);
$("fit-curves-button").addEventListener("click", fitDiscreteBoundaries);
$("render-reference-button").addEventListener("click", () => renderReferenceFills());
$("export-svg-button").addEventListener("click", () => {
  void downloadFlatColoredSvg();
});
$("remove-overlay-button").addEventListener("click", removeOverlay);
$("vector-render-size").addEventListener("change", applyVectorRenderSize);
$("overlay-opacity").addEventListener("input", (event) => {
  $("overlay-opacity-value").textContent = `${Math.round(Number(event.target.value) * 100)}%`;
  draw();
});
$("clear-log-button").addEventListener("click", () => {
  $("run-log-list").replaceChildren();
});
installLiveRebuildListeners();

for (const id of [
  "display-evidence",
  "display-targets",
  "display-assignments",
  "display-label-boundary",
  "display-normals",
  "display-controls",
  "display-initial",
]) {
  $(id).addEventListener("change", draw);
}

window.addEventListener("keydown", (event) => {
  const editing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    optimize();
  } else if (!editing && event.key.toLowerCase() === "f") {
    fitView();
  } else if (!editing && event.key.toLowerCase() === "r") {
    resetProblem();
  }
});

new ResizeObserver(resizeCanvas).observe($("canvas-frame"));

async function bootstrap() {
  installParameterHelp();
  setPreset("wave");
  try {
    // Initialize the backend (WASM preferred, server fallback).
    await Backend.init();
    const [health, defaults] = await Promise.all([
      Backend.call("/api/health"),
      Backend.call("/api/defaults"),
    ]);
    state.nativeDefaults = defaults;
    applyNativeDefaultsPayload(defaults);
    $("native-state").dataset.state = "ready";
    const backendLabel = Backend.describe() === "wasm" ? "WASM" : "server";
    $("native-state-text").textContent = `${health.backend} · ${health.library} (${backendLabel})`;
    logRun(`Native C API connected via ${backendLabel} backend.`);
  } catch (error) {
    $("native-state").dataset.state = "error";
    $("native-state-text").textContent = "Native core unavailable";
    $("metric-status").textContent = "Offline";
    $("metric-status-detail").textContent = error.message;
  }
  requestAnimationFrame(() => {
    resizeCanvas();
    fitView();
  });
}

bootstrap();
