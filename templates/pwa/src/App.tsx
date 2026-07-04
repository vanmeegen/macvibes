// Leere Start-App. Die Bausteine für interaktive Auswertungen liegen bereit:
// - components/ExcelDropZone.tsx  (Excel per Drag & Drop einlesen, SheetJS)
// - components/DemoChart.tsx      (Recharts-Dashboard)
// - models/DataStore.ts           (MobX-Store für die eingelesenen Daten)
// Beschreibe im macvibes-Chat, was die App können soll — der Agent baut es hier auf.
export const App = () => (
  <main className="app">
    <div className="app__welcome">
      <h1>Deine App</h1>
      <p className="app__subtitle">Erstellt mit macvibes</p>
      <p className="app__hint">
        Beschreibe im Chat, was die App können soll — der Agent baut sie hier auf.
      </p>
    </div>
  </main>
);
