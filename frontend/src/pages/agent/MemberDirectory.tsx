// frontend/src/pages/agent/MemberDirectory.tsx
import { Filter, Search } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { AgentService } from '../../services/agent/agent.service';
import { AgentMember } from '../../types/agent/agent.types';

const MemberDirectory = () => {
    const [allMembers, setAllMembers] = useState<AgentMember[]>([]);
    const [filteredMembers, setFilteredMembers] = useState<AgentMember[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchMembers = async () => {
            try {
                setLoading(true);
                const response = await AgentService.getAssignedMembers({});
                if (response.success && response.data) {
                    setAllMembers(response.data);
                    setFilteredMembers(response.data);
                } else {
                    setError(response.message || 'Failed to fetch members.');
                }
            } catch (err) {
                setError('Failed to fetch members.');
                console.error(err);
            } finally {
                setLoading(false);
            }
        };
        fetchMembers();
    }, []);

    const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
        const term = e.target.value;
        setSearchTerm(term);
        const filtered = allMembers.filter(member =>
            member.firstName.toLowerCase().includes(term.toLowerCase()) ||
            member.lastName.toLowerCase().includes(term.toLowerCase()) ||
            member.email.toLowerCase().includes(term.toLowerCase()) ||
            (member.groupName && member.groupName.toLowerCase().includes(term.toLowerCase()))
        );
        setFilteredMembers(filtered);
    };

    if (loading) return <div>Loading...</div>;
    if (error) return <div className="text-red-500">{error}</div>;
    
    return (
        <div className="p-6">
            <h1 className="text-2xl font-semibold text-gray-900 mb-2">Member Directory</h1>
            <p className="text-gray-600 mb-6">View and manage assigned members.</p>
            
            <div className="flex items-center justify-between mb-4">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                    <input
                        type="text"
                        placeholder="Search members..."
                        value={searchTerm}
                        onChange={handleSearch}
                        className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    />
                </div>
                <button className="flex items-center px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
                    <Filter className="h-5 w-5 mr-2" />
                    Filter
                </button>
            </div>

            <div className="bg-white rounded-lg border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Group</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                            <th scope="col" className="relative px-6 py-3">
                                <span className="sr-only">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {filteredMembers.map((member) => (
                            <tr key={member.memberId}>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <div className="text-sm font-medium text-gray-900">{member.firstName} {member.lastName}</div>
                                    <div className="text-sm text-gray-500">{member.email}</div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{member.groupName}</td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                        member.status === 'Active' ? 'bg-green-100 text-green-800' :
                                        member.status === 'Pending' ? 'bg-yellow-100 text-yellow-800' :
                                        'bg-red-100 text-red-800'
                                    }`}>
                                        {member.status}
                                    </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                    <a href="#" className="text-oe-primary hover:text-blue-900">View</a>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default MemberDirectory;
