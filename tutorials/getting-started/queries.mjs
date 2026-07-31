// The five continuous queries for the Getting Started tutorial, ported from the
// upstream Drasi Server tutorial. Each one demonstrates a different capability
// over the same `Message` feed:
//
//   all-messages           : change detection — every message, kept current
//   hello-world-senders    : a WHERE filter — only "Hello World" messages
//   message-counts         : aggregation — count of each unique message text
//   inactive-senders       : time / absence of change — senders idle > 20s
//   messages-with-location : cross-source join — messages ⋈ live user locations
//
// All are written in Cypher. The first four read only the PostgreSQL `Message`
// source; the last joins it with the HTTP `UserLocation` source.

export const SOURCE_MESSAGES = 'messages';
export const SOURCE_LOCATIONS = 'location-tracker';

// Virtual relationship for the cross-source join: a Message's `From` matches a
// UserLocation's `name`. There is no foreign key — the two sources are separate
// systems — so Drasi materializes the relationship from these keys.
const FROM_USER = {
  id: 'FROM_USER',
  keys: [
    { label: 'Message', property: 'From' },
    { label: 'UserLocation', property: 'name' },
  ],
};

export const QUERIES = [
  // 1. Change detection: every message, passed through unchanged.
  {
    id: 'all-messages',
    sources: [SOURCE_MESSAGES],
    joins: [],
    query: `
      MATCH (m:Message)
      RETURN
        m.MessageId AS MessageId,
        m.From AS From,
        m.Message AS Message
    `,
  },

  // 2. Filter: only messages whose text is exactly 'Hello World'.
  {
    id: 'hello-world-senders',
    sources: [SOURCE_MESSAGES],
    joins: [],
    query: `
      MATCH (m:Message)
      WHERE m.Message = 'Hello World'
      RETURN
        m.MessageId AS Id,
        m.From AS Sender
    `,
  },

  // 3. Aggregation: how many times each unique message text has been sent.
  {
    id: 'message-counts',
    sources: [SOURCE_MESSAGES],
    joins: [],
    query: `
      MATCH (m:Message)
      RETURN
        m.Message AS MessageText,
        count(m) AS Count
    `,
  },

  // 4. Time-based / absence of change: senders who have not sent a message in
  //    the last 20 seconds. drasi.trueLater schedules a future re-evaluation so
  //    a sender appears the instant they cross the 20s threshold, with no new
  //    data and no polling.
  {
    id: 'inactive-senders',
    sources: [SOURCE_MESSAGES],
    joins: [],
    query: `
      MATCH (m:Message)
      WITH m.From AS MessageFrom, max(drasi.changeDateTime(m)) AS LastMessageTimestamp
      WHERE LastMessageTimestamp <= datetime.realtime() - duration({ seconds: 20 })
         OR drasi.trueLater(
              LastMessageTimestamp <= datetime.realtime() - duration({ seconds: 20 }),
              LastMessageTimestamp + duration({ seconds: 20 }))
      RETURN
        MessageFrom,
        LastMessageTimestamp
    `,
  },

  // 5. Cross-source join: messages joined with their sender's live location.
  //    NOTE: the PostgreSQL `messages` source is listed FIRST. Cross-source
  //    query bootstrap is currently order-dependent — a source listed second can
  //    bootstrap 0 rows — so we list the source whose rows drive the match
  //    first. See drasi-project/drasi-core#682.
  {
    id: 'messages-with-location',
    sources: [SOURCE_MESSAGES, SOURCE_LOCATIONS],
    joins: [FROM_USER],
    query: `
      MATCH (m:Message)-[:FROM_USER]->(u:UserLocation)
      RETURN
        m.MessageId AS Id,
        m.Message AS Message,
        m.From AS Sender,
        u.location AS Location,
        u.status AS Status
    `,
  },
];

export const QUERY_IDS = QUERIES.map((q) => q.id);
