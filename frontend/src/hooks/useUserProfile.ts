import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { UserProfileResponse, UserService } from '../services/user.service';

/**
 * Hook to fetch and return the current user's complete profile data
 */
export const useUserProfile = () => {
  const { user: authUser, isLoading: isAuthLoading } = useAuth();

  return useQuery({
    queryKey: ['userProfile'],
    queryFn: () => UserService.getCurrentUserProfile(),
    enabled: !isAuthLoading && !!authUser,
    select: (response) => {
      if (response.success) {
        return response.data as UserProfileResponse;
      }
      return null;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

export default useUserProfile; 