#!/usr/bin/env python3
"""Validate documentation pack structure, hashes, JSON/Schema examples and YAML/TOML syntax."""
from pathlib import Path
import hashlib, json, sys, tomllib, re
root=Path(__file__).resolve().parents[1]
errors=[]
manifest=(root/'MANIFEST.sha256').read_text(encoding='utf-8').splitlines()
for row in manifest:
    expected,rel=row.split('  ',1)
    p=root/rel
    if not p.is_file():errors.append(f'Missing: {rel}');continue
    actual=hashlib.sha256(p.read_bytes()).hexdigest()
    if actual!=expected:errors.append(f'Checksum: {rel}')
for p in root.rglob('*.json'):
    try:json.loads(p.read_text(encoding='utf-8'))
    except Exception as e:errors.append(f'JSON {p.relative_to(root)}: {e}')
for p in root.rglob('*.toml'):
    try:tomllib.loads(p.read_text(encoding='utf-8'))
    except Exception as e:errors.append(f'TOML {p.relative_to(root)}: {e}')
try:
    import yaml
    for p in root.rglob('*.yaml'):
        try: yaml.safe_load(p.read_text(encoding='utf-8'))
        except Exception as e:errors.append(f'YAML {p.relative_to(root)}: {e}')
except ImportError:
    print('WARN: PyYAML unavailable; YAML syntax not checked')
try:
    from jsonschema import Draft202012Validator, validate
    scdir=root/'contracts'/'proposed'
    for p in scdir.glob('*.schema.json'):
        try:Draft202012Validator.check_schema(json.loads(p.read_text()))
        except Exception as e:errors.append(f'Schema {p.name}: {e}')
    pairs={'worker-request.example.json':'worker-request.v1.schema.json','worker-result.example.json':'worker-event.v1.schema.json','worker-progress.example.json':'worker-event.v1.schema.json'}
    for example,schema in pairs.items():
        try:
            validate(instance=json.loads((scdir/'examples'/example).read_text()),schema=json.loads((scdir/schema).read_text()))
        except Exception as e:errors.append(f'Schema example {example}: {e}')
except ImportError:
    print('WARN: jsonschema unavailable; JSON schema validation not checked')
# Check markdown relative links only when normal links point inside current pack.
for p in root.rglob('*.md'):
    text=p.read_text(encoding='utf-8')
    for dest in re.findall(r'\]\(([^)]+)\)',text):
        if dest.startswith(('http://','https://','mailto:','#','sandbox:','data:')):continue
        if '#' in dest:dest=dest.split('#')[0]
        if not dest:continue
        target=(p.parent/dest).resolve()
        if not target.is_file() and not target.is_dir():
            errors.append(f'Missing MD link in {p.relative_to(root)}: {dest}')
print('Files:',len(list(root.rglob('*'))),'Manifest:',len(manifest),'Errors:',len(errors))
for e in errors[:100]: print('ERROR:',e)
sys.exit(1 if errors else 0)
