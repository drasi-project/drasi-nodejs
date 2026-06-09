-- Drasi Trading Demo — database schema + seed data.
--
-- Trimmed from drasi-server's examples/trading/database/init.sql: keeps only the
-- reference data consumed by this demo (stocks / portfolio / watchlist) and the
-- logical-replication objects Drasi's postgres CDC source subscribes to. The
-- limit-orders / broker pieces are intentionally omitted.

-- Create the replication-capable user the Drasi source connects as.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_user WHERE usename = 'drasi_user') THEN
        CREATE USER drasi_user WITH REPLICATION LOGIN PASSWORD 'drasi_password';
    END IF;
END
$$;

GRANT CREATE ON DATABASE trading_demo TO drasi_user;
GRANT ALL PRIVILEGES ON DATABASE trading_demo TO drasi_user;

-- Static stock information.
CREATE TABLE stocks (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(10) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    sector VARCHAR(100),
    industry VARCHAR(100),
    market_cap BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Portfolio positions.
CREATE TABLE portfolio (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) DEFAULT 'demo_user',
    symbol VARCHAR(10) NOT NULL,
    quantity INTEGER NOT NULL,
    purchase_price DECIMAL(10, 2) NOT NULL,
    purchase_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (symbol) REFERENCES stocks(symbol) ON DELETE CASCADE
);

-- Watchlist entries.
CREATE TABLE watchlist (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) DEFAULT 'demo_user',
    symbol VARCHAR(10) NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (symbol) REFERENCES stocks(symbol) ON DELETE CASCADE,
    UNIQUE(user_id, symbol)
);

CREATE INDEX idx_stocks_symbol ON stocks(symbol);
CREATE INDEX idx_stocks_sector ON stocks(sector);
CREATE INDEX idx_portfolio_user_symbol ON portfolio(user_id, symbol);
CREATE INDEX idx_watchlist_user_symbol ON watchlist(user_id, symbol);

-- REPLICA IDENTITY FULL so CDC sees full before/after rows for updates/deletes.
ALTER TABLE stocks REPLICA IDENTITY FULL;
ALTER TABLE portfolio REPLICA IDENTITY FULL;
ALTER TABLE watchlist REPLICA IDENTITY FULL;

ALTER TABLE stocks OWNER TO drasi_user;
ALTER TABLE portfolio OWNER TO drasi_user;
ALTER TABLE watchlist OWNER TO drasi_user;

GRANT USAGE ON SCHEMA public TO drasi_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO drasi_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO drasi_user;

-- Logical-replication publication the Drasi postgres source subscribes to.
-- NOTE: we intentionally do NOT pre-create the replication slot here. The Drasi
-- source creates it automatically on first connect (at the current WAL position,
-- i.e. *after* the seed rows below). Pre-creating the slot before seeding would
-- make CDC replay the seed INSERTs on top of the bootstrap snapshot, double-
-- counting every row.
CREATE PUBLICATION drasi_trading_pub FOR TABLE stocks, portfolio, watchlist;

-- Sample stock universe (matches data/initial-prices.jsonl symbols).
INSERT INTO stocks (symbol, name, sector, industry, market_cap) VALUES
    ('AAPL', 'Apple Inc.', 'Technology', 'Consumer Electronics', 3000000000000),
    ('MSFT', 'Microsoft Corporation', 'Technology', 'Software', 2800000000000),
    ('GOOGL', 'Alphabet Inc.', 'Technology', 'Internet Services', 1700000000000),
    ('META', 'Meta Platforms', 'Technology', 'Social Media', 900000000000),
    ('NVDA', 'NVIDIA Corporation', 'Technology', 'Semiconductors', 1100000000000),
    ('AMD', 'Advanced Micro Devices', 'Technology', 'Semiconductors', 230000000000),
    ('INTC', 'Intel Corporation', 'Technology', 'Semiconductors', 150000000000),
    ('CRM', 'Salesforce', 'Technology', 'Software', 270000000000),
    ('ORCL', 'Oracle Corporation', 'Technology', 'Software', 320000000000),
    ('ADBE', 'Adobe Inc.', 'Technology', 'Software', 220000000000),
    ('JPM', 'JPMorgan Chase', 'Financial', 'Banking', 500000000000),
    ('BAC', 'Bank of America', 'Financial', 'Banking', 280000000000),
    ('GS', 'Goldman Sachs', 'Financial', 'Investment Banking', 130000000000),
    ('V', 'Visa Inc.', 'Financial', 'Payment Processing', 530000000000),
    ('MA', 'Mastercard', 'Financial', 'Payment Processing', 400000000000),
    ('JNJ', 'Johnson & Johnson', 'Healthcare', 'Pharmaceuticals', 380000000000),
    ('UNH', 'UnitedHealth Group', 'Healthcare', 'Health Insurance', 520000000000),
    ('PFE', 'Pfizer Inc.', 'Healthcare', 'Pharmaceuticals', 160000000000),
    ('LLY', 'Eli Lilly', 'Healthcare', 'Pharmaceuticals', 570000000000),
    ('AMZN', 'Amazon.com', 'Consumer', 'E-commerce', 1700000000000),
    ('TSLA', 'Tesla Inc.', 'Consumer', 'Electric Vehicles', 800000000000),
    ('WMT', 'Walmart Inc.', 'Consumer', 'Retail', 480000000000),
    ('HD', 'Home Depot', 'Consumer', 'Home Improvement', 400000000000),
    ('MCD', 'McDonalds', 'Consumer', 'Restaurants', 210000000000),
    ('KO', 'Coca-Cola', 'Consumer', 'Beverages', 280000000000),
    ('XOM', 'Exxon Mobil', 'Energy', 'Oil & Gas', 450000000000),
    ('CVX', 'Chevron', 'Energy', 'Oil & Gas', 300000000000),
    ('BA', 'Boeing', 'Industrial', 'Aerospace', 130000000000),
    ('CAT', 'Caterpillar', 'Industrial', 'Machinery', 160000000000),
    ('GE', 'General Electric', 'Industrial', 'Conglomerate', 180000000000);

-- Sample portfolio positions.
INSERT INTO portfolio (user_id, symbol, quantity, purchase_price, purchase_date) VALUES
    ('demo_user', 'AAPL', 100, 165.00, '2024-01-15 10:30:00'),
    ('demo_user', 'MSFT', 50, 380.00, '2024-01-20 14:15:00'),
    ('demo_user', 'GOOGL', 75, 135.50, '2024-02-01 09:45:00'),
    ('demo_user', 'NVDA', 25, 750.00, '2024-02-10 11:20:00'),
    ('demo_user', 'TSLA', 40, 220.00, '2024-02-15 13:30:00'),
    ('demo_user', 'JPM', 80, 185.00, '2024-03-01 10:00:00'),
    ('demo_user', 'V', 60, 265.00, '2024-03-05 15:45:00'),
    ('demo_user', 'JNJ', 45, 150.00, '2024-03-10 12:00:00');

-- Sample watchlist (stocks not in the portfolio).
INSERT INTO watchlist (user_id, symbol) VALUES
    ('demo_user', 'META'),
    ('demo_user', 'AMZN'),
    ('demo_user', 'AMD');

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO drasi_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO drasi_user;
