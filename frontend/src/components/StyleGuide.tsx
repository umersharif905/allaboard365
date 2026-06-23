import React from 'react';
import { Check, X, AlertTriangle, Info,
  Save, Trash2, Plus, Download,
  Users, Settings, Home, FileText, BarChart
} from 'lucide-react';

export default function StyleGuide() {
  return (
    <div className="min-h-screen bg-oe-neutral-light p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-oe-neutral-dark mb-2">
            AllAboard365 Style Guide
          </h1>
          <p className="text-gray-600">
            Corporate design system and component library
          </p>
        </div>

        {/* Color Palette */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6">Corporate Colors</h2>
          <div className="grid grid-cols-4 gap-4">
            <div className="space-y-2">
              <div className="h-24 bg-oe-primary rounded-lg shadow-md flex items-center justify-center text-white font-semibold">
                Primary
              </div>
              <p className="text-sm font-medium">Sky Blue</p>
              <p className="text-xs text-gray-500">#1f8dbf</p>
            </div>
            <div className="space-y-2">
              <div className="h-24 bg-oe-light rounded-lg shadow-md flex items-center justify-center text-oe-dark font-semibold">
                Light
              </div>
              <p className="text-sm font-medium">Light Sky</p>
              <p className="text-xs text-gray-500">#d6eef8</p>
            </div>
            <div className="space-y-2">
              <div className="h-24 bg-oe-dark rounded-lg shadow-md flex items-center justify-center text-white font-semibold">
                Dark
              </div>
              <p className="text-sm font-medium">Midnight Blue</p>
              <p className="text-xs text-gray-500">#125e82</p>
            </div>
            <div className="space-y-2">
              <div className="h-24 bg-oe-neutral-light rounded-lg shadow-md border border-gray-200 flex items-center justify-center text-gray-700 font-semibold">
                Neutral
              </div>
              <p className="text-sm font-medium">Snow White</p>
              <p className="text-xs text-gray-500">#f7f9fa</p>
            </div>
          </div>
          
          <div className="grid grid-cols-4 gap-4 mt-4">
            <div className="space-y-2">
              <div className="h-24 bg-oe-success rounded-lg shadow-md flex items-center justify-center text-white font-semibold">
                Success
              </div>
              <p className="text-sm font-medium">Green Light</p>
              <p className="text-xs text-gray-500">#4caf50</p>
            </div>
            <div className="space-y-2">
              <div className="h-24 bg-oe-error rounded-lg shadow-md flex items-center justify-center text-white font-semibold">
                Error
              </div>
              <p className="text-sm font-medium">Alert Red</p>
              <p className="text-xs text-gray-500">#e53935</p>
            </div>
            <div className="space-y-2">
              <div className="h-24 bg-oe-warning rounded-lg shadow-md flex items-center justify-center text-white font-semibold">
                Warning
              </div>
              <p className="text-sm font-medium">Gold Amber</p>
              <p className="text-xs text-gray-500">#ffb300</p>
            </div>
            <div className="space-y-2">
              <div className="h-24 bg-oe-neutral-dark rounded-lg shadow-md flex items-center justify-center text-white font-semibold">
                Text
              </div>
              <p className="text-sm font-medium">Slate Gray</p>
              <p className="text-xs text-gray-500">#2b2b2b</p>
            </div>
          </div>
        </section>

        {/* Typography */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6">Typography</h2>
          <div className="card">
            <div className="space-y-4">
              <h1 className="text-4xl font-bold">Heading 1 - Bold 4xl</h1>
              <h2 className="text-3xl font-semibold">Heading 2 - Semibold 3xl</h2>
              <h3 className="text-2xl font-semibold">Heading 3 - Semibold 2xl</h3>
              <h4 className="text-xl font-medium">Heading 4 - Medium xl</h4>
              <h5 className="text-lg font-medium">Heading 5 - Medium lg</h5>
              <p className="text-base">Body text - Regular base size using Inter font family.</p>
              <p className="text-sm text-gray-600">Small text - Used for descriptions and metadata.</p>
              <p className="text-xs text-gray-500">Extra small - Used for labels and hints.</p>
            </div>
          </div>
        </section>

        {/* Buttons */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6">Buttons</h2>
          <div className="card">
            <div className="space-y-6">
              {/* Standard Buttons */}
              <div>
                <h3 className="text-lg font-medium mb-3">Standard Buttons</h3>
                <div className="flex flex-wrap gap-4">
                  <button className="btn-primary">Primary Button</button>
                  <button className="btn-secondary">Secondary Button</button>
                  <button className="btn-danger">Danger Button</button>
                  <button className="btn-primary" disabled>Disabled</button>
                </div>
              </div>
              
              {/* Icon Buttons */}
              <div>
                <h3 className="text-lg font-medium mb-3">Icon Buttons</h3>
                <div className="flex flex-wrap gap-4">
                  <button className="btn-primary flex items-center">
                    <Save className="w-4 h-4 mr-2" />
                    Save Changes
                  </button>
                  <button className="btn-secondary flex items-center">
                    <Plus className="w-4 h-4 mr-2" />
                    Add New
                  </button>
                  <button className="btn-danger flex items-center">
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </button>
                </div>
              </div>
              
              {/* Button Sizes */}
              <div>
                <h3 className="text-lg font-medium mb-3">Button Sizes</h3>
                <div className="flex flex-wrap items-center gap-4">
                  <button className="btn-primary text-xs px-3 py-1">Small</button>
                  <button className="btn-primary">Default</button>
                  <button className="btn-primary text-lg px-6 py-3">Large</button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Form Elements */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6">Form Elements</h2>
          <div className="card">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="form-label">Text Input</label>
                <input type="text" className="form-input" placeholder="Enter text..." />
              </div>
              
              <div>
                <label className="form-label">Email Input</label>
                <input type="email" className="form-input" placeholder="email@example.com" />
              </div>
              
              <div>
                <label className="form-label">Select Dropdown</label>
                <select className="form-select">
                  <option>Option 1</option>
                  <option>Option 2</option>
                  <option>Option 3</option>
                </select>
              </div>
              
              <div>
                <label className="form-label">Date Input</label>
                <input type="date" className="form-input" />
              </div>
              
              <div className="col-span-2">
                <label className="form-label">Textarea</label>
                <textarea className="form-input" rows={3} placeholder="Enter description..."></textarea>
              </div>
              
              <div className="col-span-2">
                <label className="form-label">Checkboxes</label>
                <div className="space-y-2">
                  <label className="flex items-center">
                    <input type="checkbox" className="mr-2 rounded text-oe-primary focus:ring-oe-primary" />
                    <span>Option 1</span>
                  </label>
                  <label className="flex items-center">
                    <input type="checkbox" className="mr-2 rounded text-oe-primary focus:ring-oe-primary" />
                    <span>Option 2</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Alerts */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6">Alerts & Messages</h2>
          <div className="space-y-4">
            <div className="alert alert-success flex items-center">
              <Check className="w-5 h-5 mr-2 flex-shrink-0" />
              <span>Success! Your changes have been saved.</span>
            </div>
            <div className="alert alert-error flex items-center">
              <X className="w-5 h-5 mr-2 flex-shrink-0" />
              <span>Error! Something went wrong. Please try again.</span>
            </div>
            <div className="alert alert-warning flex items-center">
              <AlertTriangle className="w-5 h-5 mr-2 flex-shrink-0" />
              <span>Warning! This action cannot be undone.</span>
            </div>
            <div className="alert alert-info flex items-center">
              <Info className="w-5 h-5 mr-2 flex-shrink-0" />
              <span>Info: New features have been added to your account.</span>
            </div>
          </div>
        </section>

        {/* Cards */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6">Cards & Containers</h2>
          <div className="grid grid-cols-3 gap-6">
            <div className="card">
              <h3 className="text-lg font-semibold mb-2">Basic Card</h3>
              <p className="text-gray-600">Standard card with shadow and padding.</p>
            </div>
            <div className="card hover-lift">
              <h3 className="text-lg font-semibold mb-2">Hover Lift Card</h3>
              <p className="text-gray-600">This card lifts slightly on hover.</p>
            </div>
            <div className="card hover-glow">
              <h3 className="text-lg font-semibold mb-2">Hover Glow Card</h3>
              <p className="text-gray-600">This card glows with shadow on hover.</p>
            </div>
          </div>
          
          <div className="mt-6">
            <div className="card bg-gradient-soft">
              <h3 className="text-lg font-semibold mb-2">Gradient Background Card</h3>
              <p className="text-gray-600">Card with subtle gradient background using corporate colors.</p>
            </div>
          </div>
        </section>

        {/* Badges */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6">Badges & Labels</h2>
          <div className="card">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <span className="badge badge-primary">Primary</span>
                <span className="badge badge-success">Success</span>
                <span className="badge badge-warning">Warning</span>
                <span className="badge badge-error">Error</span>
              </div>
              
              <div className="flex flex-wrap gap-3">
                <span className="badge badge-primary flex items-center">
                  <div className="w-2 h-2 bg-oe-primary rounded-full mr-1"></div>
                  Active
                </span>
                <span className="badge badge-warning flex items-center">
                  <div className="w-2 h-2 bg-oe-warning rounded-full mr-1"></div>
                  Pending
                </span>
                <span className="badge badge-error flex items-center">
                  <div className="w-2 h-2 bg-oe-error rounded-full mr-1"></div>
                  Inactive
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Icons */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6">Icons (Lucide React)</h2>
          <div className="card">
            <div className="grid grid-cols-6 gap-4">
              <div className="text-center">
                <Home className="w-6 h-6 mx-auto mb-2 text-gray-600" />
                <p className="text-xs">Home</p>
              </div>
              <div className="text-center">
                <Users className="w-6 h-6 mx-auto mb-2 text-gray-600" />
                <p className="text-xs">Users</p>
              </div>
              <div className="text-center">
                <Settings className="w-6 h-6 mx-auto mb-2 text-gray-600" />
                <p className="text-xs">Settings</p>
              </div>
              <div className="text-center">
                <FileText className="w-6 h-6 mx-auto mb-2 text-gray-600" />
                <p className="text-xs">Files</p>
              </div>
              <div className="text-center">
                <BarChart className="w-6 h-6 mx-auto mb-2 text-gray-600" />
                <p className="text-xs">Analytics</p>
              </div>
              <div className="text-center">
                <Download className="w-6 h-6 mx-auto mb-2 text-gray-600" />
                <p className="text-xs">Download</p>
              </div>
            </div>
          </div>
        </section>

        {/* Usage Examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6">Implementation Guide</h2>
          <div className="card">
            <div className="prose max-w-none">
              <h3 className="text-lg font-semibold mb-3">Quick Reference</h3>
              <div className="bg-gray-100 p-4 rounded-md font-mono text-sm">
                <p className="mb-2">// Colors</p>
                <p className="text-gray-600">bg-oe-primary, text-oe-primary, border-oe-primary</p>
                <p className="text-gray-600 mb-4">bg-oe-light, bg-oe-dark, bg-oe-success, bg-oe-error</p>
                
                <p className="mb-2">// Components</p>
                <p className="text-gray-600">btn-primary, btn-secondary, btn-danger</p>
                <p className="text-gray-600">form-input, form-label, form-select</p>
                <p className="text-gray-600">card, alert, badge</p>
                <p className="text-gray-600 mb-4">hover-lift, hover-glow, animate-fade-in</p>
                
                <p className="mb-2">// Utilities</p>
                <p className="text-gray-600">bg-gradient-primary, bg-gradient-soft</p>
                <p className="text-gray-600">focus-ring, shadow-soft, shadow-medium</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

