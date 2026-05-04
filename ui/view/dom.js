// Cached references to the static DOM scaffolding declared in view.html.
// Looking these up once at module load is cheaper than repeatedly
// querying — and keeps every consumer module's import list short.
export const dropZone = document.getElementById('drop-zone')
export const report = document.getElementById('report')
export const sidebar = document.getElementById('sidebar')
export const fileList = document.getElementById('file-list')
