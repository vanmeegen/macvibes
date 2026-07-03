import { observer } from 'mobx-react-lite';
import { DemoChart } from './components/DemoChart';
import { ExcelDropZone } from './components/ExcelDropZone';
import type { DataStore } from './models/DataStore';

export const App = observer(({ store }: { store: DataStore }) => (
  <ExcelDropZone store={store}>
    <header className="app__header">
      <h1>Dashboard</h1>
      <p className="app__subtitle">
        Excel-Datei hochladen und die Daten direkt im Browser auswerten — ganz ohne Server.
      </p>
    </header>
    <main>
      <DemoChart store={store} />
    </main>
  </ExcelDropZone>
));
