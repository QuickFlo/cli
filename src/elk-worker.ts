// Local worker entrypoint so `deno compile` bundles ELK's worker alongside the
// CLI. The imported UMD bundle installs the worker message handler on `self`.
import 'elkjs/lib/elk-worker.min.js';
