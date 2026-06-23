import { NavLink, Outlet } from 'react-router-dom';
import { usePublicFormsContext } from '../../hooks/usePublicFormsContext';

export default function TenantSharingFormsLayout() {
  const { routeBase } = usePublicFormsContext();
  return (
    <div>
      <div className="px-6 pt-6 border-b border-gray-200 bg-white">
        <nav className="flex gap-8" aria-label="Forms sections">
          <NavLink
            to={routeBase}
            end
            className={({ isActive }) =>
              `pb-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`
            }
          >
            Forms
          </NavLink>
          <NavLink
            to={`${routeBase}/submissions`}
            className={({ isActive }) =>
              `pb-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`
            }
          >
            Submissions
          </NavLink>
          <NavLink
            to={`${routeBase}/drafts`}
            className={({ isActive }) =>
              `pb-3 text-sm font-medium border-b-2 -mb-px ${
                isActive
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`
            }
          >
            In Progress
          </NavLink>
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
