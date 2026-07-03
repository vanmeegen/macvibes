import { observer } from 'mobx-react-lite';
import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { DataStore } from '../models/DataStore';

interface ExcelDropZoneProps {
  store: DataStore;
  children: ReactNode;
}

/**
 * Flächendeckende Drag-&-Drop-Zone für Excel-Dateien mit zusätzlichem
 * Dateiauswahl-Button. Parse-Fehler aus dem Store werden sichtbar gemeldet.
 */
export const ExcelDropZone = observer(({ store, children }: ExcelDropZoneProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (event.currentTarget === event.target) {
      setDragActive(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (file) {
      void store.loadWorkbook(file);
    }
  };

  return (
    <div
      className={dragActive ? 'dropzone dropzone--active' : 'dropzone'}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="dropzone__bar">
        <button
          type="button"
          className="dropzone__button"
          onClick={() => inputRef.current?.click()}
          disabled={store.loading}
        >
          {store.loading ? 'Wird geladen …' : 'Excel-Datei auswählen'}
        </button>
        <span className="dropzone__hint">
          {store.isSampleData
            ? 'Eigene Excel-Datei hierher ziehen — die Beispieldaten werden ersetzt.'
            : `Geladen: ${store.fileName ?? ''} (Blatt „${store.sheetName ?? ''}“)`}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void store.loadWorkbook(file);
            }
            event.target.value = '';
          }}
        />
      </div>
      {store.error !== null && (
        <p className="dropzone__error" role="alert">
          {store.error}
        </p>
      )}
      {children}
      {dragActive && <div className="dropzone__overlay">Datei hier ablegen</div>}
    </div>
  );
});
