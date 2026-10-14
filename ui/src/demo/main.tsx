// The website demo's entry (ui/demo.html): the app's own entry, after the in-browser backend.
// Order matters: each import runs before the next.
import './staleBuild';
import './buffer';
import './install';
import '../main';
