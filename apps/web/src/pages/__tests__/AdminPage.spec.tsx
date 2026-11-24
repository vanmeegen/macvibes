import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gqlRequest } from '../../api/graphqlClient';
import { makeAuthStore, makeUser } from '../../__tests__/factories';
import { AdminUsersStore } from '../../models/AdminUsersStore';
import { AdminPage } from '../AdminPage';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

const mockGql = vi.mocked(gqlRequest);

const admin = makeUser({ id: 'u1', username: 'marco', role: 'admin' });
const pending = makeUser({ id: 'u2', username: 'gast', approved: false });

function renderPage(): AdminUsersStore {
  const store = new AdminUsersStore(makeAuthStore('marco', 'admin'));
  render(
    <MemoryRouter>
      <AdminPage adminUsersStore={store} />
    </MemoryRouter>,
  );
  return store;
}

describe('AdminPage', () => {
  beforeEach(() => {
    mockGql.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('lädt die Nutzerliste und zeigt die Zahl der Wartenden', async () => {
    mockGql.mockResolvedValue({ users: [admin, pending] });
    renderPage();

    expect(await screen.findByTestId('admin-pending-count')).toHaveTextContent('1');
    expect(screen.getAllByTestId('admin-user-row')).toHaveLength(2);
    expect(screen.queryByTestId('admin-error')).not.toBeInTheDocument();
  });

  it('zeigt einen Fehler beim Freischalten AUF der Admin-Seite an', async () => {
    mockGql.mockResolvedValueOnce({ users: [admin, pending] });
    renderPage();
    const approve = await screen.findByTestId('admin-approve');

    mockGql.mockRejectedValueOnce(new Error('Freischalten fehlgeschlagen'));
    fireEvent.click(approve);

    expect(await screen.findByTestId('admin-error')).toHaveTextContent(
      'Freischalten fehlgeschlagen',
    );
  });

  it('zeigt einen Ladefehler an statt einer scheinbar leeren Liste ohne Erklärung', async () => {
    mockGql.mockRejectedValueOnce(new Error('Netz weg'));
    renderPage();

    expect(await screen.findByTestId('admin-error')).toHaveTextContent('Netz weg');
  });
});
