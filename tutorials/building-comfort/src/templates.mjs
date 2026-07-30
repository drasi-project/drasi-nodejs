// Handlebars templates that SHAPE raw continuous-query rows into a single,
// display-ready JSON snapshot for the browser. This is the heart of the "SSE
// reaction": instead of streaming raw query results, the reaction runs these
// templates so the front end receives exactly the structure it renders.
//
// The template emits JSON text (values are serialized with the `json` helper so
// the output is always valid), which the reaction then `JSON.parse`s before
// pushing over SSE.

import Handlebars from 'handlebars';

// --- Helpers -----------------------------------------------------------------

// Serialize any value as valid JSON (numbers, strings, null). Marked SafeString
// so Handlebars doesn't HTML-escape the quotes.
Handlebars.registerHelper('json', (value) =>
  new Handlebars.SafeString(JSON.stringify(value ?? null)),
);

// Classify a comfort level: comfortable band is 40-50.
Handlebars.registerHelper('comfortStatus', (level) => {
  const n = Number(level);
  if (!Number.isFinite(n)) return 'unknown';
  if (n > 50) return 'hot';
  if (n < 40) return 'cold';
  return 'ok';
});

// Average of `field` across `items` (used for the overall building comfort KPI,
// mirroring the upstream dashboard's "avg of building-comfort-ui" KPI).
Handlebars.registerHelper('avgField', (items, field) => {
  const nums = (items || []).map((i) => Number(i[field])).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
});

Handlebars.registerHelper('round', (n) => (n == null ? null : Math.round(Number(n))));

// Block helper: group an array of rows by a field. Inside the block, `this` is
// the group (an array), `@key` is the group value, and `@first`/`@last`/`@index`
// support comma placement when emitting a JSON array.
Handlebars.registerHelper('groupBy', function groupBy(items, field, options) {
  const groups = new Map();
  for (const item of items || []) {
    const key = item[field];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const entries = [...groups.entries()];
  let out = '';
  entries.forEach(([key, group], index) => {
    const data = Handlebars.createFrame(options.data || {});
    data.key = key;
    data.index = index;
    data.first = index === 0;
    data.last = index === entries.length - 1;
    out += options.fn(group, { data });
  });
  return out;
});

// --- The snapshot template ---------------------------------------------------
// Context: { ui, floorComfort, roomAlerts, floorAlerts } — each a query's rows.

const SNAPSHOT_SOURCE = `{
  "buildingName": {{json (or ui.0.BuildingName "Building")}},
  "overallComfort": {{json (round (avgField ui "ComfortLevel"))}},
  "roomCount": {{json ui.length}},
  "floors": [
    {{#groupBy ui "FloorName"}}
    {
      "floorName": {{json @key}},
      "floorId": {{json (lookup (lookup this 0) "FloorId")}},
      "rooms": [
        {{#each this}}
        {
          "roomId": {{json this.RoomId}},
          "roomName": {{json this.RoomName}},
          "comfortLevel": {{json this.ComfortLevel}},
          "status": {{json (comfortStatus this.ComfortLevel)}},
          "temperature": {{json this.Temperature}},
          "humidity": {{json this.Humidity}},
          "co2": {{json this.CO2}}
        }{{#unless @last}},{{/unless}}
        {{/each}}
      ]
    }{{#unless @last}},{{/unless}}
    {{/groupBy}}
  ],
  "floorComfort": [
    {{#each floorComfort}}
    {
      "floorId": {{json this.FloorId}},
      "comfortLevel": {{json (round this.ComfortLevel)}}
    }{{#unless @last}},{{/unless}}
    {{/each}}
  ],
  "roomAlerts": [
    {{#each roomAlerts}}
    {
      "roomId": {{json this.RoomId}},
      "roomName": {{json this.RoomName}},
      "comfortLevel": {{json this.ComfortLevel}}
    }{{#unless @last}},{{/unless}}
    {{/each}}
  ],
  "floorAlerts": [
    {{#each floorAlerts}}
    {
      "floorId": {{json this.FloorId}},
      "floorName": {{json this.FloorName}},
      "comfortLevel": {{json (round this.ComfortLevel)}}
    }{{#unless @last}},{{/unless}}
    {{/each}}
  ]
}`;

// Small helper used only in the template for a safe default building name.
Handlebars.registerHelper('or', (a, b) => a || b);

const snapshotTemplate = Handlebars.compile(SNAPSHOT_SOURCE, { noEscape: true });

/**
 * Shape the six queries' rows into the display-ready snapshot object the browser
 * renders. Throws a descriptive error if the template ever emits invalid JSON.
 */
export function renderSnapshot(context) {
  const text = snapshotTemplate(context);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Handlebars produced invalid JSON: ${err.message}\n---\n${text}\n---`);
  }
}
