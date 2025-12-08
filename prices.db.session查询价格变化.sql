
SELECT
    t1.id,
    t1.Platform,
    t1.URL,
    t1.Price AS latest_price,
    t2.Price AS previous_price,
    t1.Price - t2.Price AS price_change,
    CASE
        WHEN t1.Price > t2.Price THEN '涨价'
        WHEN t1.Price < t2.Price THEN '注意，商品降价'
        ELSE 'No Change'
    END AS price_status
FROM
    price_data AS t1
JOIN
    price_data AS t2 ON t1.URL = t2.URL -- 关键更改：使用 URL 进行匹配
WHERE
    t1.Scrape_Date = (SELECT MAX(Scrape_Date) FROM price_data) -- 最新日期
    AND t2.Scrape_Date = (SELECT MAX(Scrape_Date) FROM price_data WHERE Scrape_Date < (SELECT MAX(Scrape_Date) FROM price_data)) -- 次新日期
    AND t1.Price <> t2.Price;


