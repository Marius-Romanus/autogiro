# Tejados de OpenStreetMap de todo el mundo (roof:shape y compañía) sacados de Overture Maps,
# que publica los edificios de OSM con esos atributos en GeoParquet abierto (S3, sin cuenta).
# Solo se leen el rectángulo envolvente y los atributos del tejado (no la geometría): unos pocos
# GB de red en total, nada a disco salvo los TSV de salida (~600 MB). Unos 25 minutos.
#
#   pip install duckdb        (DuckDB lee los Parquet por rangos)
#   python tools/world-roofs-overture.py <carpeta de salida> [versión de Overture, p. ej. 2026-11-18.0]
#   node --experimental-strip-types tools/world-roofs-pack.ts <carpeta de salida> fecha=20261118
#
# Se puede interrumpir y volver a lanzar: los archivos ya hechos no se repiten.
# Versiones publicadas: https://docs.overturemaps.org/release/latest/

import os
import sys
import time

import duckdb

if len(sys.argv) < 2:
    sys.exit('uso: world-roofs-overture.py <carpeta de salida> [versión]')
OUT = sys.argv[1]
REL = sys.argv[2] if len(sys.argv) > 2 else '2026-11-18.0'
BASE = f's3://overturemaps-us-west-2/release/{REL}/theme=buildings'
os.makedirs(OUT, exist_ok=True)

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
files = [r[0] for r in con.execute(f"SELECT file FROM glob('{BASE}/type=building/*.parquet')").fetchall()]
jobs = [('building_part', f'{BASE}/type=building_part/*.parquet', 1)] + [(f'building-{i:05d}', f, 0) for i, f in enumerate(files)]

t0 = time.time()
total = 0
for k, (name, pattern, part) in enumerate(jobs):
    dst = os.path.join(OUT, f'{name}.csv')
    if os.path.exists(dst):
        continue
    for attempt in range(4):
        try:
            con.execute(f"""COPY (
              SELECT bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax, roof_shape, height, min_height, roof_height,
                     roof_direction, roof_orientation, roof_color, roof_material, {part}
              FROM read_parquet('{pattern}') WHERE roof_shape IS NOT NULL
            ) TO '{dst}.tmp' (HEADER false, DELIMITER '\t')""")
            os.replace(dst + '.tmp', dst)
            break
        except Exception as e:  # cortes de red: se reintenta
            print('reintento', name, e, flush=True)
            time.sleep(5 * (attempt + 1))
    else:
        sys.exit(f'no se pudo leer {name}')
    with open(dst, encoding='utf-8') as f:
        total += sum(1 for _ in f)
    print(f'{k + 1}/{len(jobs)} {name}: {total} tejados, {round(time.time() - t0)} s', flush=True)
print('fin', total, round(time.time() - t0), 's')
