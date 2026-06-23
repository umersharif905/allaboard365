// frontend/src/pages/agent/GroupEnrollment.tsx
import { MAX_LARGE_UPLOAD_MB } from '../../constants/uploads';
import { Upload, UserPlus } from 'lucide-react';
import { useState } from 'react';

const BulkImportTab = () => (
    <div className="border border-gray-200 rounded-lg p-6 mt-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Bulk Import Members</h2>
        <div className="flex items-center justify-center w-full">
            <label htmlFor="dropzone-file" className="flex flex-col items-center justify-center w-full h-64 border-2 border-gray-300 border-dashed rounded-lg cursor-pointer bg-gray-50 hover:bg-gray-100">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <Upload className="w-10 h-10 mb-3 text-gray-400" />
                    <p className="mb-2 text-sm text-gray-500"><span className="font-semibold">Click to upload</span> or drag and drop</p>
                    <p className="text-xs text-gray-500">CSV, XLS, or XLSX (MAX. {MAX_LARGE_UPLOAD_MB}MB)</p>
                </div>
                <input id="dropzone-file" type="file" className="hidden" />
            </label>
        </div>
        <div className="mt-4 text-right">
            <button className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark">Upload and Process</button>
        </div>
    </div>
);

const ManualEntryTab = () => (
    <div className="border border-gray-200 rounded-lg p-6 mt-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Add Single Member</h2>
        <form className="space-y-4">
            <div>
                <label htmlFor="fullName" className="block text-sm font-medium text-gray-700">Full Name</label>
                <input type="text" id="fullName" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-oe-primary focus:border-oe-primary" />
            </div>
            <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700">Email Address</label>
                <input type="email" id="email" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-oe-primary focus:border-oe-primary" />
            </div>
            <div>
                <label htmlFor="group" className="block text-sm font-medium text-gray-700">Group</label>
                <select id="group" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-oe-primary focus:border-oe-primary">
                    <option>Stark Industries</option>
                    <option>Wayne Enterprises</option>
                    <option>Oscorp</option>
                </select>
            </div>
            <div className="text-right">
                <button type="submit" className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark">Add Member</button>
            </div>
        </form>
    </div>
);

const GroupEnrollment = () => {
    const [activeTab, setActiveTab] = useState('bulk');

    return (
        <div className="p-6">
            <h1 className="text-2xl font-semibold text-gray-900 mb-2">Group Enrollment</h1>
            <p className="text-gray-600 mb-6">Enroll group members via import or manual form entry.</p>

            <div className="border-b border-gray-200">
                <nav className="-mb-px flex space-x-8" aria-label="Tabs">
                    <button
                        onClick={() => setActiveTab('bulk')}
                        className={`whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm ${activeTab === 'bulk' ? 'border-oe-primary text-oe-primary' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                    >
                        <Upload className="-ml-0.5 mr-2 h-5 w-5 inline" />
                        Bulk Import
                    </button>
                    <button
                        onClick={() => setActiveTab('manual')}
                        className={`whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm ${activeTab === 'manual' ? 'border-oe-primary text-oe-primary' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                    >
                        <UserPlus className="-ml-0.5 mr-2 h-5 w-5 inline" />
                        Manual Entry
                    </button>
                </nav>
            </div>

            {activeTab === 'bulk' ? <BulkImportTab /> : <ManualEntryTab />}
        </div>
    );
};

export default GroupEnrollment;
