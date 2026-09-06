# Sensor Resampling and Gap Report

## Environment and fresh grading

Python 3.12 and Bash are available. Extra shell utilities are not guaranteed.
Do not rely on background processes or `/tmp` files surviving across tool calls.
Use files under the editable workspace for scratch data needed by a later call.

Fresh grading copies only your `solution/` directory. It regenerates the reading stream and sensor metadata and runs the command in separate main and edge workspaces. Your generated output and scratch files are not copied. Recreate all three reports from the supplied inputs.

Use Python 3.12 and only the standard library. Implement:

```bash
python3.12 -E -S -m solution.sensor_resample inputs/readings.csv.gz inputs/sensors.json --output output
```

`readings.csv.gz` is UTF-8 CSV with header `timestamp,sensor_id,value,status`. Timestamps are UTC instants written as `YYYY-MM-DDTHH:MM:SSZ`. Rows for different sensors are interleaved. Within each sensor timestamps are nondecreasing; the whole interleaved stream need not be globally time-sorted. `sensors.json` maps every sensor ID to `gauge` or `counter`. Process the large gzip stream without loading it all at once.

Use five-minute UTC half-open buckets `[start, start + 5 minutes)`. Ignore every `status=BAD` row completely.

For a gauge, aggregate good readings in each bucket. For a counter, compare consecutive good readings for that sensor:

* assign a non-negative delta to the bucket containing the later reading;
* a decrease contributes no delta, starts a new counter run, and creates a reset row;
* do not output a counter bucket unless it receives at least one delta.

A gap is longer than 15 minutes between consecutive good readings for one sensor. BAD readings do not break or shorten it.

Create these files:

* `output/resampled.csv.gz`, header `bucket_start_utc,sensor_id,kind,count,min,max,mean,delta`. For gauges fill `count,min,max,mean` and leave `delta` empty. For counters fill `delta` and leave the four gauge fields empty. Sort by `(bucket_start_utc, sensor_id)`.
* `output/resets.csv`, header `sensor_id,previous_timestamp,current_timestamp,previous_value,current_value`. Sort by `(current_timestamp, sensor_id)`.
* `output/gaps.csv`, header `sensor_id,start_timestamp,end_timestamp,duration_seconds`. Sort by `(start_timestamp, sensor_id, end_timestamp)`.

Write bucket timestamps in the same UTC form. Preserve input numeric spellings in reset rows. In resampled rows, write decimals in plain notation with trailing fractional zeroes removed (write zero as `0`). Arithmetic means are exact for this fixture. Durations are decimal integer seconds.

A bucket that contains only BAD readings must not appear in `resampled.csv.gz`; surrounding good readings can still form a reported gap.
