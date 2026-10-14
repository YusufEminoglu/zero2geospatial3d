// Resolve the bare 'three' specifier to the vendored build, as the browser's
// import map does, so viewer modules can be imported by node --test.
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.resolve(here, '../../web/vendor/three');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three') {
      return { url: pathToFileURL(path.join(vendor, 'three.module.js')).href, shortCircuit: true };
    }
    if (specifier.startsWith('three/addons/')) {
      return { url: pathToFileURL(path.join(vendor, 'addons', specifier.slice('three/addons/'.length))).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
