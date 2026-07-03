import { observer } from 'mobx-react-lite';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DataStore } from '../models/DataStore';

/** Feste Serienfarben (validierte Palette), nie rotierend zugewiesen. */
const SERIES_COLORS = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948'];

const numberFormat = new Intl.NumberFormat('de-DE');

/**
 * Balkendiagramm über die aggregierten Daten des Stores, plus kompakte
 * Datentabelle als zweiter Lesekanal (Werte nie nur über Farbe).
 */
export const DemoChart = observer(({ store }: { store: DataStore }) => {
  if (store.chartRows.length === 0 || store.labelKey === null || store.valueKeys.length === 0) {
    return (
      <p className="chart__empty">
        Keine darstellbaren Daten gefunden. Erwartet wird ein Tabellenblatt mit einer
        Beschriftungsspalte und mindestens einer Zahlenspalte.
      </p>
    );
  }

  return (
    <section className="chart">
      <h2 className="chart__title">
        {store.isSampleData ? 'Beispiel: Umsatz und Kosten pro Monat' : 'Auswertung'}
      </h2>
      <div className="chart__plot">
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={store.chartRows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis
              dataKey={store.labelKey}
              stroke="var(--muted-ink)"
              tickLine={false}
              axisLine={{ stroke: 'var(--baseline)' }}
            />
            <YAxis
              stroke="var(--muted-ink)"
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => numberFormat.format(value)}
            />
            <Tooltip
              formatter={(value: number | string) =>
                typeof value === 'number' ? numberFormat.format(value) : value
              }
              cursor={{ fill: 'var(--hover-wash)' }}
            />
            {store.valueKeys.length > 1 && <Legend />}
            {store.valueKeys.map((key, index) => (
              <Bar
                key={key}
                dataKey={key}
                fill={SERIES_COLORS[index % SERIES_COLORS.length]}
                radius={[4, 4, 0, 0]}
                maxBarSize={40}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="chart__table-wrap">
        <table className="chart__table">
          <thead>
            <tr>
              <th>{store.labelKey}</th>
              {store.valueKeys.map((key) => (
                <th key={key}>{key}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {store.chartRows.map((row, index) => (
              <tr key={index}>
                <td>{String(row[store.labelKey ?? ''] ?? '')}</td>
                {store.valueKeys.map((key) => {
                  const value = row[key];
                  return (
                    <td key={key} className="chart__number">
                      {typeof value === 'number' ? numberFormat.format(value) : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
});
