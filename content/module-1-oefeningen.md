---
module: 1
order: 2
tocMode: page
tocLabel: Oefeningen
published: true
---

# Oefeningen Module 1

Voer `ping`{.keyword} uit naar je eigen router en noteer de gemiddelde latency.

```output
64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=2.31 ms
```

::: tip
Lukt het niet? Volg het stappenplan uit [1.6](./module-1.md#1_6).
:::

## Oefening 1: Pingtabel {.easy}

Download de [lege pingtabel](files/module-1/pingtabel.csv) en open ze in een spreadsheet.

### Noteer je resultaten

| Doel | Verwacht | Gemeten |
|---|---|---|
| Router | < 5 ms | |
| 8.8.8.8 | < 30 ms | |

## Oefening 2: Wifi of kabel {.medium}

Ping je router tien keer via wifi en daarna tien keer via een kabel. Vergelijk de gemiddelde latency en verklaar het verschil met 1.5.

## Oefening 3: Een eenvoudige PHP-check {.hard}

```php
<?php
$host = '8.8.8.8';
$result = exec("ping -c 1 " . escapeshellarg($host), $output, $code);

if ($code === 0) {
    echo "Bereikbaar: $result";
} else {
    echo "Niet bereikbaar"; // controleer stap 1 t.e.m. 4
}
```

```js
const res = await fetch('https://example.com', { signal: AbortSignal.timeout(3000) });
console.log(res.status);
```

::: jsfiddle
[Probeer de fetch-code in JSFiddle](https://jsfiddle.net/)
:::

## Oefening 4: Thuisopdracht {.home}

Teken je eigen thuisnetwerk: welke toestellen zijn verbonden met welk apparaat? Duid aan waar je LAN eindigt.

```json
{
  "router": "192.168.1.1",
  "toestellen": ["laptop", "telefoon", "printer"]
}
```

## Oefening 5: Traceroute naar drie websites {.extra}

Voer `traceroute` (of `tracert`) uit naar drie websites op verschillende continenten. Hoeveel tussenstations tel je telkens?
